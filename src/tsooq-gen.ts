import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import { exec } from 'child_process';
import { runDatabaseScript } from './setup';
import { getConfig, Config } from './config';

interface FieldDefinition {
  ordinal: number;
  fieldName: string;
  dataType: string;
  isNullable: boolean;
  hasDefault: boolean;
}

interface TableDefinition {
  schemaName: string;
  tableName: string;
  fields: FieldDefinition[];
}

const transaction: (pool: Pool, runnable: (client: PoolClient) => Promise<unknown>) => Promise<void> = (
  pool,
  runnable
) =>
  new Promise<void>((resolve, reject) => {
    pool.connect((err, client, done) => {
      if (err) {
        reject(err);
        return;
      }
      (async () => {
        try {
          await client.query('BEGIN');
          await runnable(client);
          await client.query('COMMIT');
          resolve();
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
          done();
        }
      })().catch(reject);
    });
  });

const childProccessStdout = (s: string) => console.log(`\x1b[90m${s}\x1b[0m`);

const cmd = (shellCommand: string, workingDirectory: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const cp = exec(shellCommand, { cwd: workingDirectory });
    cp.stdout.on('data', childProccessStdout);
    cp.stderr.on('data', console.error);
    cp.on('exit', resolve);
    cp.on('error', reject);
  });

const initDatabase = async (pool: Pool, config: Config): Promise<void> => {
  if (config.ddlScript) {
    const sql = fs.readFileSync(config.ddlScript).toString();
    await transaction(pool, client => client.query(sql));
  } else if (config.migrationCmd) {
    await cmd(config.migrationCmd, config.migrationWorkingDir || '.');
  } else {
    throw new Error('Either ddlScript or migrationCmd must be provided');
  }
};

const loadSchema: (pool: Pool, schemaName: string) => Promise<string[]> = (pool, schemaName) =>
  new Promise<string[]>((resolve, reject) => {
    pool.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type=$2',
      [schemaName, 'BASE TABLE'],
      (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result.rows.map(row => row.table_name));
        }
      }
    );
  });

const loadTableDefinition: (pool: Pool, schemaName: string, tableName: string) => Promise<TableDefinition> = (
  pool,
  schemaName,
  tableName
) =>
  new Promise<TableDefinition>((resolve, reject) => {
    pool.query(
      'SELECT ordinal_position, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position ASC',
      [schemaName, tableName],
      (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve({
            schemaName,
            tableName,
            fields: result.rows.map(row => ({
              ordinal: row.ordinal_position,
              fieldName: row.column_name,
              dataType: row.data_type,
              isNullable: row.is_nullable === 'YES',
              hasDefault: row.column_default != undefined,
            })),
          });
        }
      }
    );
  });

const toClassName: (s: string) => string = s => {
  const result: string[] = [];
  let upper = true;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '_') {
      upper = true;
    } else {
      result.push(upper ? s[i].toUpperCase() : s[i]);
      upper = false;
    }
  }
  return result.join('');
};

const toStaticFieldName: (s: string) => string = s => s.toUpperCase();

const toTsDataType: (s: string) => string = s => {
  if (s === 'integer' || s === 'numeric') {
    return 'number';
  } else if (s === 'character' || s === 'character varying' || s === 'text') {
    return 'string';
  } else if (s === 'date' || s === 'timestamp without time zone') {
    return 'Date';
  }
  return s;
};

const tsModel: (td: TableDefinition) => string = td => {
  const className = toClassName(td.tableName);
  let s = 'export class ' + className + ' extends TableImpl {\n';
  s += `  private static readonly _TABLE_NAME = '${td.tableName}';\n`;
  td.fields.forEach(field => {
    s += `  static readonly ${toStaticFieldName(field.fieldName)}: Field<${toTsDataType(
      field.dataType
    )}> = new FieldImpl<${toTsDataType(field.dataType)}>(${className}._TABLE_NAME, ${field.ordinal}, '${
      field.fieldName
    }', undefined, '${field.dataType}', ${field.isNullable}, ${field.hasDefault});\n`;
  });
  s += '  private static readonly _FIELDS: Field<any>[] = [';
  td.fields.forEach((field, i) => {
    s += `${className}.${toStaticFieldName(field.fieldName)}`;
    if (i < td.fields.length - 1) {
      s += ', ';
    }
  });
  s += '];\n\n';
  s += '  constructor() {\n';
  s += `    super(${className}._TABLE_NAME, undefined, ${className}._FIELDS);\n`;
  s += '  }\n';
  s += '}\n\n';
  return s;
};

const tables: (tds: TableDefinition[]) => string = tds => {
  let s = 'export class Tables {\n';
  tds.forEach(td => {
    s += `  static readonly ${toStaticFieldName(td.tableName)}: Table = new ${toClassName(td.tableName)}();\n`;
  });
  s += '}\n';
  return s;
};

const generateModel: (pool: Pool, schemaName: string, outputDir: string) => Promise<void> = async (
  pool,
  schemaName,
  outputDir
) => {
  const tableNames = (await loadSchema(pool, schemaName)).sort();
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  let s = "import { Field, FieldImpl, Table, TableImpl } from 'tsooq';\n\n";
  const tds: TableDefinition[] = [];
  for (let i = 0; i < tableNames.length; i++) {
    const td = await loadTableDefinition(pool, schemaName, tableNames[i]);
    tds.push(td);
    s += tsModel(td);
  }
  s += tables(tds);
  fs.writeFileSync(`${outputDir}/${schemaName}.ts`, s);
};

const config = getConfig();

runDatabaseScript(async pool => {
  await initDatabase(pool, config);
  await generateModel(pool, config.schemaName, config.outputDir);
}).catch(console.error);
