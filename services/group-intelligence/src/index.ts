import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/health', async () => ({
  status: 'ok',
  service: 'group-intelligence',
}));

const start = async (): Promise<void> => {
  await app.listen({ port: 4010, host: '0.0.0.0' });
};

void start();
