import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ProductService, type ProductDto, type RecommendationListDto } from './product.service';
import { ProductQueryDto } from './dto/product-query.dto';
import { AuditAction } from '../observability/audit.decorator';

@ApiTags('product')
@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  /** 今日推荐 50 款 */
  @Get('recommendations')
  recommendations(@Query() query: ProductQueryDto): Promise<RecommendationListDto> {
    return this.productService.getDailyRecommendations(query);
  }

  /** 可筛选类目、商品数与采购价范围 */
  @Get('facets')
  facets() {
    return this.productService.getFacets();
  }

  /** 按 1688 商品 ID 查询详情 */
  @AuditAction('product.detail.view', 'source_product')
  @Get(':id')
  detail(@Param('id') id: string): Promise<ProductDto> {
    return this.productService.getDetail(id);
  }
}
