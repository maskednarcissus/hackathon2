import Fastify from 'fastify';

const app = Fastify({
  logger: true,
});

app.get('/health', async () => {
  return { status: 'ok', service: 'classroom-intelligence-api' };
});

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: 4000, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
