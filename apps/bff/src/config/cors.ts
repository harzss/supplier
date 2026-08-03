export const APPLICATION_CORS_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

export function applicationCorsOptions(origins: string[]) {
  return {
    origin: origins,
    credentials: true,
    methods: [...APPLICATION_CORS_METHODS],
  };
}
