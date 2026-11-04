import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/health', async () => ({
  status: 'ok',
  service: 'device-management',
}));

const start = async (): Promise<void> => {
  await app.listen({ port: 4004, host: '0.0.0.0' });
};

void start();
