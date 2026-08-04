import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { AcknowledgeExceptionCaseDto } from './acknowledge-exception-case.dto';
import { ExceptionCaseListQueryDto } from './exception-case-list-query.dto';

describe('exception center DTOs', () => {
  it('accepts the canonical filters and converts pagination values', async () => {
    const dto = plainToInstance(ExceptionCaseListQueryDto, {
      status: 'acknowledged',
      domain: 'logistics',
      priority: 'critical',
      q: '运单',
      page: '2',
      pageSize: '50',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto).toMatchObject({ page: 2, pageSize: 50 });
  });

  it('rejects unknown filters and unbounded searches', async () => {
    const dto = plainToInstance(ExceptionCaseListQueryDto, {
      status: 'closed',
      domain: 'order_sync',
      priority: 'p0',
      q: 'x'.repeat(101),
      page: 0,
      pageSize: 101,
    });

    expect(await validate(dto)).toHaveLength(6);
  });

  it('requires a revision, UUID command id and meaningful acknowledgement note', async () => {
    const valid = plainToInstance(AcknowledgeExceptionCaseDto, {
      expectedRevision: 3,
      clientRequestId: '8e07fc63-cd13-41f2-a2de-cc7ca0fa6312',
      note: '已核对平台订单，正在跟进。',
    });
    const invalid = plainToInstance(AcknowledgeExceptionCaseDto, {
      expectedRevision: 0,
      clientRequestId: 'not-a-uuid',
      note: 'a',
    });

    await expect(validate(valid)).resolves.toEqual([]);
    expect(await validate(invalid)).toHaveLength(3);
  });
});
