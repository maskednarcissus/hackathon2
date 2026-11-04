import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/health', async () => ({
  status: 'ok',
  service: 'transcript-management',
}));

const start = async (): Promise<void> => {
  await app.listen({ port: 4008, host: '0.0.0.0' });
};

void start();
