import { Module } from '@nestjs/common';
import { ShopModule } from '../shop/shop.module';
import { CategoryCatalogController } from './category-catalog.controller';
import { CategoryCatalogService } from './category-catalog.service';
import { CategoryMappingController } from './category-mapping.controller';
import { CategoryMappingService } from './category-mapping.service';
import { CategoryPropertyController } from './category-property.controller';
import { CategoryPropertyService } from './category-property.service';
import { CategoryQualificationController } from './category-qualification.controller';
import { CategoryQualificationService } from './category-qualification.service';

@Module({
  imports: [ShopModule],
  controllers: [
    CategoryMappingController,
    CategoryCatalogController,
    CategoryPropertyController,
    CategoryQualificationController,
  ],
  providers: [
    CategoryMappingService,
    CategoryCatalogService,
    CategoryPropertyService,
    CategoryQualificationService,
  ],
  exports: [
    CategoryMappingService,
    CategoryCatalogService,
    CategoryPropertyService,
    CategoryQualificationService,
  ],
})
export class CategoryModule {}
