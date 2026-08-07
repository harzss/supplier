import { Global, Module } from '@nestjs/common';
import { PrismaModule } from './prisma.module';
import { RuntimeStateService } from './runtime-state.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [RuntimeStateService],
  exports: [RuntimeStateService],
})
export class RuntimeStateModule {}
