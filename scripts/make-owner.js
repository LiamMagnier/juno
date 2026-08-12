const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany();
  if (users.length === 0) {
    console.log("No users found.");
    return;
  }
  for (const user of users) {
    await prisma.subscription.upsert({
      where: { userId: user.id },
      update: { plan: 'OWNER', status: 'ACTIVE' },
      create: {
        userId: user.id,
        plan: 'OWNER',
        status: 'ACTIVE'
      }
    });
    console.log(`Updated user ${user.email} to OWNER.`);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
