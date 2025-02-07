import chalk from 'chalk';
import cliProgress from 'cli-progress';
import dedent from 'dedent';
import invariant from 'tiny-invariant';
import logger from '../logger';
import { loadApiProvider } from '../providers';
import type { ApiProvider, TestCase, TestSuite } from '../types';
import { REDTEAM_MODEL } from './constants';
import { getCompetitorTests } from './getCompetitorTests';
import { getHallucinationTests } from './getHallucinationTests';
import {
  getHarmfulTests,
  addInjections,
  addIterativeJailbreaks,
  HARM_CATEGORIES,
} from './getHarmfulTests';
import { getHijackingTests } from './getHijackingTests';
import { getOverconfidenceTests } from './getOverconfidenceTests';
import { getPiiTests } from './getPiiTests';
import { getPoliticalStatementsTests } from './getPoliticalStatementsTests';
import { getUnderconfidenceTests } from './getUnderconfidenceTests';
import { getContractTests } from './getUnintendedContractTests';

interface SynthesizeOptions {
  injectVar?: string;
  plugins: string[];
  prompts: string[];
  provider?: string;
  purpose?: string;
}

const BASE_PLUGINS = [
  'contracts',
  'excessive-agency',
  'hallucination',
  'harmful',
  'hijacking',
  'jailbreak',
  'overreliance',
  'pii',
  'politics',
  'prompt-injection',
];

export const ADDITIONAL_PLUGINS = ['competitors'];

export const DEFAULT_PLUGINS = new Set([...BASE_PLUGINS, ...Object.keys(HARM_CATEGORIES)]);
const ALL_PLUGINS = new Set([...DEFAULT_PLUGINS, ...ADDITIONAL_PLUGINS]);

function validatePlugins(plugins: string[]) {
  for (const plugin of plugins) {
    if (!ALL_PLUGINS.has(plugin)) {
      throw new Error(
        `Invalid plugin: ${plugin}. Must be one of: ${Array.from(ALL_PLUGINS).join(', ')}`,
      );
    }
  }
}

export async function synthesizeFromTestSuite(
  testSuite: TestSuite,
  options: Partial<SynthesizeOptions>,
) {
  return synthesize({
    ...options,
    plugins:
      options.plugins && options.plugins.length > 0 ? options.plugins : Array.from(DEFAULT_PLUGINS),
    prompts: testSuite.prompts.map((prompt) => prompt.raw),
  });
}

export async function synthesize({
  prompts,
  provider,
  injectVar,
  purpose: purposeOverride,
  plugins,
}: SynthesizeOptions) {
  validatePlugins(plugins);
  const reasoningProvider = await loadApiProvider(provider || REDTEAM_MODEL);
  logger.info(
    `Synthesizing test cases for ${prompts.length} ${
      prompts.length === 1 ? 'prompt' : 'prompts'
    }...\nPlugins: ${chalk.yellow(plugins.join(', '))}`,
  );

  // Initialize progress bar
  const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  const totalSteps = plugins.length + 2; // +2 for initial setup steps
  let currentStep = 0;

  if (process.env.LOG_LEVEL !== 'debug') {
    progressBar.start(100, 0);
  }

  const updateProgress = () => {
    currentStep += 1;
    const progress = Math.floor((currentStep / totalSteps) * 100);
    progressBar.update(progress);
  };

  // Get vars
  injectVar = injectVar || 'query';

  // Get purpose
  updateProgress();
  const purpose = purposeOverride || (await getPurpose(prompts, reasoningProvider));
  updateProgress();

  logger.debug(`System purpose: ${purpose}`);

  // Get adversarial test cases
  const testCases: TestCase[] = [];
  const adversarialPrompts: TestCase[] = [];

  const redteamProvider: ApiProvider = await loadApiProvider(provider || REDTEAM_MODEL, {
    options: {
      config: { temperature: 0.5 },
    },
  });

  const addHarmfulCases = plugins.some((p) => p.startsWith('harmful'));
  if (plugins.includes('prompt-injection') || plugins.includes('jailbreak') || addHarmfulCases) {
    logger.debug('Generating harmful test cases');
    const harmfulPrompts = await getHarmfulTests(
      redteamProvider,
      purpose,
      injectVar,
      plugins.filter((p) => p.startsWith('harmful:')),
    );
    adversarialPrompts.push(...harmfulPrompts);

    if (addHarmfulCases) {
      testCases.push(...harmfulPrompts);
      logger.debug(`Added ${harmfulPrompts.length} harmful test cases`);
    } else {
      logger.debug(`Generated ${harmfulPrompts.length} harmful test cases`);
    }
  }

  const pluginActions: {
    [key: string]: (
      provider: ApiProvider,
      purpose: string,
      injectVar: string,
    ) => Promise<TestCase[]>;
  } = {
    jailbreak: (provider, purpose, injectVar) =>
      addIterativeJailbreaks(provider, adversarialPrompts, purpose, injectVar),
    'prompt-injection': (provider, purpose, injectVar) =>
      addInjections(provider, adversarialPrompts, purpose, injectVar),
    pii: getPiiTests,
    'excessive-agency': getOverconfidenceTests,
    hijacking: getHijackingTests,
    hallucination: getHallucinationTests,
    overreliance: getUnderconfidenceTests,
    competitors: getCompetitorTests,
    contracts: getContractTests,
    politics: getPoliticalStatementsTests,
  };

  for (const plugin of plugins) {
    if (pluginActions[plugin]) {
      updateProgress();
      logger.debug(`Generating ${plugin} tests`);
      const pluginTests = await pluginActions[plugin](redteamProvider, purpose, injectVar);
      testCases.push(...pluginTests);
      logger.debug(`Added ${pluginTests.length} ${plugin} test cases`);
    }
  }

  // Finish progress bar
  if (process.env.LOG_LEVEL !== 'debug') {
    progressBar.update(100);
    progressBar.stop();
  }

  return testCases;
}

async function getPurpose(prompts: string[], provider: ApiProvider): Promise<string> {
  const { output: purpose } = await provider.callApi(dedent`
    The following are prompts that are being used to test an LLM application:
    
    ${prompts
      .map(
        (prompt) => dedent`
      <prompt>
      ${prompt}
      </prompt>`,
      )
      .join('\n')}
    
    Given the above prompts, output the "system purpose" of the application in a single sentence.
    
    Example outputs:
    - Provide users a way to manage finances
    - Executive assistant that helps with scheduling and reminders
    - Ecommerce chatbot that sells shoes
  `);

  invariant(typeof purpose === 'string', `Expected purpose to be a string, got: ${purpose}`);
  return purpose;
}
