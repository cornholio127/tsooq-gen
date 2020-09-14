import { Docker } from 'node-docker-api';
import { Pool, PoolConfig, Client } from 'pg';
import { Container } from 'node-docker-api/lib/container';
import { setInterval } from 'timers';
import { platform } from 'os';
import { Stream } from 'stream';

const DOCKER_IMAGE = 'postgres';
const DOCKER_IMAGE_TAG = '12.4-alpine';

const DB_USER = 'setup';
const DB_PASSWORD = 's3cr3t';
const DB_NAME = 'setup';
const DB_PORT = 45432;

const poolConfig: PoolConfig = {
  host: 'localhost',
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
};

const createPool = () => new Pool(poolConfig);

const log = (s: string) => console.log(`\x1b[33m${s}\x1b[0m`);

const promisifyStream = (stream: Stream) =>
  new Promise((resolve, reject) => {
    stream.on('data', (d: Buffer) => d.toString());
    stream.on('end', resolve);
    stream.on('error', reject);
  });

const pullImage = (docker: Docker) => {
  log('Pulling image...');
  return docker.image
    .create(
      {},
      {
        fromImage: DOCKER_IMAGE,
        tag: DOCKER_IMAGE_TAG,
      }
    )
    .then(promisifyStream);
};

const createContainer = (docker: Docker) => {
  log('Creating container...');
  return docker.container.create({
    Image: `${DOCKER_IMAGE}:${DOCKER_IMAGE_TAG}`,
    name: 'db-setup',
    Env: [`POSTGRES_USER=${DB_USER}`, `POSTGRES_PASSWORD=${DB_PASSWORD}`, `POSTGRES_DB=${DB_NAME}`],
    ExposedPorts: {
      '5432': {},
    },
    HostConfig: {
      PortBindings: { '5432/tcp': [{ HostPort: '' + DB_PORT }] },
    },
  });
};

const deleteContainer = (container: Container) => {
  log('Deleting container...');
  return container.delete({ force: true });
};

const stopContainer = (container: Container) => {
  log('Stopping container...');
  return container.stop();
};

const startContainer = (container: Container) => {
  log('Starting container...');
  return container.start();
};

const waitForDatabase = () =>
  new Promise<void>(resolve => {
    log('Waiting for database...');
    const intv = setInterval(() => {
      const client = new Client(poolConfig);
      client
        .connect()
        .then(() => {
          clearInterval(intv);
          client
            .end()
            .then(() => {
              resolve();
            })
            .catch(console.log);
        })
        .catch(console.error);
    }, 1000);
  });

const createDocker = () => {
  if (platform() === 'win32') {
    return new Docker({ socketPath: '//./pipe/docker_engine' });
  } else {
    return new Docker({ socketPath: '/var/run/docker.sock' });
  }
};

const runDatabaseScript = (script: (pool: Pool) => Promise<void>): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const docker = createDocker();
    (async () => {
      await pullImage(docker);
      const container = await createContainer(docker);
      await startContainer(container);
      await waitForDatabase();
      log('Running sql script...');
      const pool = createPool();
      await script(pool);
      await pool.end();
      await stopContainer(container);
      await deleteContainer(container);
    })()
      .then(() => {
        log('Done.');
        resolve();
      })
      .catch(reject);
  });

export { runDatabaseScript };
