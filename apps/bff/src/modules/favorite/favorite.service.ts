import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.module';
import { serializeProduct, type ProductDto } from '../product/product.service';

export interface FavoriteProductDto extends ProductDto {
  favoritedAt: string;
}

export interface FavoriteListDto {
  total: number;
  items: FavoriteProductDto[];
}

@Injectable()
export class FavoriteService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: bigint): Promise<FavoriteListDto> {
    const favorites = await this.prisma.userFavorite.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { sourceProduct: { include: { score: true } } },
    });
    return {
      total: favorites.length,
      items: favorites.map((favorite) => ({
        ...serializeProduct(favorite.sourceProduct),
        favoritedAt: favorite.createdAt.toISOString(),
      })),
    };
  }

  async add(userId: bigint, productId1688: string): Promise<FavoriteProductDto> {
    const product = await this.prisma.sourceProduct.findUnique({
      where: { productId1688 },
      include: { score: true },
    });
    if (!product) throw new NotFoundException('货源商品不存在');

    const favorite = await this.prisma.userFavorite.upsert({
      where: { userId_sourceProductId: { userId, sourceProductId: product.id } },
      create: { userId, sourceProductId: product.id },
      update: {},
    });
    return { ...serializeProduct(product), favoritedAt: favorite.createdAt.toISOString() };
  }

  async remove(userId: bigint, productId1688: string): Promise<{ removed: boolean }> {
    const result = await this.prisma.userFavorite.deleteMany({
      where: { userId, sourceProduct: { productId1688 } },
    });
    return { removed: result.count > 0 };
  }
}
