import fs from 'node:fs';
import path from 'node:path';
import type { Unused18nConfig } from './types.js';

const CONFIG_FILE_NAME = '.unused18nrc';

type ConfigValidator = (value: unknown) => boolean;

// Requiring one validator per public field keeps runtime JSON checks aligned with the generated type.
const configValidators = {
  $schema: isNonEmptyString,
  project: isNonEmptyString,
  dictionary: isNonEmptyString,
  dictionaryExport: isNonEmptyString,
  maxExpansions: (value) => typeof value === 'number' && Number.isInteger(value) && value > 0,
  remove: (value) => typeof value === 'boolean',
  cache: (value) => typeof value === 'boolean',
  cacheDir: isNonEmptyString,
  cacheStats: (value) => typeof value === 'boolean'
} satisfies Record<keyof Unused18nConfig, ConfigValidator>;

export interface LoadedConfig {
  config: Unused18nConfig;
  fileName?: string;
}

export class ConfigFileError extends Error {
  override name = 'ConfigFileError';
}

/** Missing implicit configuration is normal; every other read or validation failure is actionable. */
export function loadConfig(explicitPath?: string, cwd = process.cwd()): LoadedConfig {
  const fileName = path.resolve(cwd, explicitPath ?? CONFIG_FILE_NAME);
  let source: string;
  try {
    source = fs.readFileSync(fileName, 'utf8');
  } catch (error) {
    if (!explicitPath && isNodeError(error) && error.code === 'ENOENT') return { config: {} };
    throw new ConfigFileError(`Cannot read config ${fileName}: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ConfigFileError(`Cannot parse config ${fileName}: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) {
    throw new ConfigFileError(`Config ${fileName} must contain a JSON object.`);
  }

  for (const [key, option] of Object.entries(value)) {
    if (!Object.hasOwn(configValidators, key)) {
      throw new ConfigFileError(`Config ${fileName} contains unknown option "${key}".`);
    }
    const validator = configValidators[key as keyof Unused18nConfig];
    if (!validator(option)) {
      throw new ConfigFileError(`Config ${fileName} has an invalid value for "${key}".`);
    }
  }

  const config = value as Unused18nConfig;
  const directory = path.dirname(fileName);
  return {
    config: {
      ...config,
      ...(config.project ? { project: path.resolve(directory, config.project) } : {}),
      ...(config.dictionary ? { dictionary: path.resolve(directory, config.dictionary) } : {}),
      ...(config.cacheDir ? { cacheDir: path.resolve(directory, config.cacheDir) } : {})
    },
    fileName
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
