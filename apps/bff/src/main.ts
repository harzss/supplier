import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { corsOrigins, swaggerEnabled } from './config/environment';
import { applicationCorsOptions } from './config/cors';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );
  const environment = app.get(ConfigService);
  const nodeEnv = environment.get<string>('NODE_ENV') ?? 'development';

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  const allowedOrigins = corsOrigins(environment.get('CORS_ORIGINS'), nodeEnv === 'production');
  app.enableCors(applicationCorsOptions(allowedOrigins));

  if (swaggerEnabled(nodeEnv, environment.get('SWAGGER_ENABLED'))) {
    const config = new DocumentBuilder()
      .setTitle('Supplier BFF')
      .setDescription('AI-powered 1688 distribution tool — BFF API')
      .setVersion('0.0.1')
      .addBearerAuth()
      .build();
    const doc = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, doc, { ui: false, raw: ['json'] });
  }

  const port = environment.get<number>('PORT') ?? 3001;
  const host = environment.get<string>('BFF_HOST') ?? '0.0.0.0';
  await app.listen(port, host);
  console.log(`[BFF] listening on ${host}:${port} (${nodeEnv})`);
}

void bootstrap();
