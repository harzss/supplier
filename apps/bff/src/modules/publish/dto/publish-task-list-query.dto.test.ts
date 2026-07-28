import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { PublishTaskListQueryDto } from './publish-task-list-query.dto';

describe('PublishTaskListQueryDto', () => {
  it('uses defaults and transforms valid pagination values', async () => {
    const defaults = plainToInstance(PublishTaskListQueryDto, {});
    const query = plainToInstance(PublishTaskListQueryDto, { page: '2', pageSize: '50' });

    await expect(validate(defaults)).resolves.toHaveLength(0);
    await expect(validate(query)).resolves.toHaveLength(0);
    expect(defaults).toMatchObject({ page: 1, pageSize: 20 });
    expect(query).toMatchObject({ page: 2, pageSize: 50 });
  });

  it('rejects invalid page numbers and oversized pages', async () => {
    const invalidPage = plainToInstance(PublishTaskListQueryDto, { page: '0' });
    const oversized = plainToInstance(PublishTaskListQueryDto, { pageSize: '101' });

    expect(await validate(invalidPage)).not.toHaveLength(0);
    expect(await validate(oversized)).not.toHaveLength(0);
  });
});
