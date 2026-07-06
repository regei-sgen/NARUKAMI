import { PrismaClient } from './generated/prisma';

export const prisma = new PrismaClient();

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
