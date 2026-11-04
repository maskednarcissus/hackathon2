import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/health', async () => ({
  status: 'ok',
  service: 'academic-analytics',
}));

const start = async (): Promise<void> => {
  await app.listen({ port: 4009, host: '0.0.0.0' });
};

void start();
