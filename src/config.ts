import * as jsonFile from 'jsonfile';
import * as fs from 'fs';

const DEFAULT_CONFIG_FILE = './.tsooq.json';

export interface Config {
  ddlScript?: string;
  migrationCmd?: string;
  migrationWorkingDir?: string;
  outputDir: string;
  schemaName: string;
}

const readConfig = (filename: string) => {
  const config: Config = jsonFile.readFileSync(filename);
  return config;
};

export const getConfig = (): Config => {
  const configFile = process.env.CONFIG || DEFAULT_CONFIG_FILE;
  if (fs.existsSync(configFile)) {
    return readConfig(configFile);
  }
  throw new Error(`Config file ${configFile} not found`);
};
