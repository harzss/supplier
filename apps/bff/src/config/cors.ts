import type { NestFastifyApplication } from '@nestjs/platform-fastify';

type FastifyCorsOptions = NonNullable<Parameters<NestFastifyApplication['enableCors']>[0]>;

export const APPLICATION_CORS_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

export function applicationCorsOptions(origins: string[]): FastifyCorsOptions {
  const allowedOrigins = new Set(origins);
  return {
    origin: (requestOrigin, callback) => {
      callback(
        null,
        requestOrigin !== undefined && allowedOrigins.has(requestOrigin) ? requestOrigin : false,
      );
    },
    credentials: true,
    methods: [...APPLICATION_CORS_METHODS],
  };
}
