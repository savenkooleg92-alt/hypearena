const { PrismaClient } = require('./node_modules/@prisma/client');

(async () => {
  const p = new PrismaClient();
  console.log('has withdrawalRequest:', !!p.withdrawalRequest);
  await p.$disconnect();
})();
