import { PrismaClient } from '../packages/db/dist/index.js';

const e2eUserPhone = 'e2e-publish-gate';
const e2eUserIdEnvironmentKey = 'SUPPLIER_E2E_USER_ID';

export default async function globalSetup() {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    await prisma.user.deleteMany({ where: { phone: e2eUserPhone } });
    const user = await prisma.user.create({
      data: { phone: e2eUserPhone, nickname: 'E2E 发布预检用户', plan: 'pro' },
      select: { id: true },
    });
    process.env[e2eUserIdEnvironmentKey] = user.id.toString();

    return async () => {
      await prisma.user.deleteMany({ where: { id: user.id, phone: e2eUserPhone } });
      await prisma.$disconnect();
    };
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}
