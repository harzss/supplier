import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { APPLICATION_CORS_METHODS, applicationCorsOptions } from './cors';

@Module({})
class CorsTestModule {}

describe('applicationCorsOptions', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('allows configured origins and rejects credentialed preflight for every other origin', async () => {
    const origin = 'https://supplier.example.com';
    app = await NestFactory.create<NestFastifyApplication>(
      CorsTestModule,
      new FastifyAdapter({ logger: false }),
      { logger: false },
    );
    app.enableCors(applicationCorsOptions([origin]));
    await app.init();

    for (const requestedMethod of ['PUT', 'DELETE']) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/publish-drafts/current',
        headers: {
          origin,
          'access-control-request-method': requestedMethod,
          'access-control-request-headers': 'authorization,content-type',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(String(response.headers['access-control-allow-methods']).split(/,\s*/)).toEqual(
        APPLICATION_CORS_METHODS,
      );
      expect(
        String(response.headers['access-control-allow-headers'])
          .split(/,\s*/)
          .map((header) => header.toLowerCase()),
      ).toEqual(['authorization', 'content-type']);
    }

    const rejected = await app.inject({
      method: 'OPTIONS',
      url: '/api/publish-drafts/current',
      headers: {
        origin: 'https://cors-probe.invalid',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    expect(rejected.statusCode < 200 || rejected.statusCode >= 300).toBe(true);
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
    expect(rejected.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
