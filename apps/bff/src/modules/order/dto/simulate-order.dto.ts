import { IsString } from 'class-validator';

export class SimulateOrderDto {
  @IsString()
  publishedProductId!: string;
}
