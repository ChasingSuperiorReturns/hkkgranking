import { PrismaClient } from '@prisma/client';

let prismaInstance: PrismaClient | undefined;

export const prisma = (() => {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient();
  }
  return prismaInstance;
})();
