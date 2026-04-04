import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const validators = [
  {
    pubkey: "GCCD6AJOYZCUAQLX32ZJF2MKFFAUJ53PVCFQI3RHWKL3V47QYE2BNAUT",
    uptime: 0.999,
    commission: 0.05,
    votingPower: 0.12,
    performanceScore: 0.97,
    allocatedStake: BigInt(50_000_0000000),
    lastChecked: new Date(),
  },
  {
    pubkey: "GABMKJM6I25XI4K7U6XWMULOUQIQ27BCTMLS6BYYSOWCTCI4K3FC6FZP",
    uptime: 0.998,
    commission: 0.08,
    votingPower: 0.09,
    performanceScore: 0.95,
    allocatedStake: BigInt(30_000_0000000),
    lastChecked: new Date(),
  },
  {
    pubkey: "GA7PIKSFTHXFXEMMO3OQMBYLS5IPWMW5JRUGNB7KZFY7SOXWKDB5BEJM",
    uptime: 0.997,
    commission: 0.1,
    votingPower: 0.07,
    performanceScore: 0.93,
    allocatedStake: BigInt(20_000_0000000),
    lastChecked: new Date(),
  },
  {
    pubkey: "GDXQJKZOGSMML2PAE7PH7GRSYIVEMO7HKLDIATWM63KCZPGBMB7FRP5G",
    uptime: 0.995,
    commission: 0.06,
    votingPower: 0.1,
    performanceScore: 0.96,
    allocatedStake: BigInt(40_000_0000000),
    lastChecked: new Date(),
  },
  {
    pubkey: "GCVHEKSRASJBD6O2Z532LWH4N2ZLCBVDLLTLKSYCSMBLOYTNMEEGUARD",
    uptime: 0.996,
    commission: 0.12,
    votingPower: 0.06,
    performanceScore: 0.91,
    allocatedStake: BigInt(15_000_0000000),
    lastChecked: new Date(),
  },
];

async function main() {
  console.log("Seeding validators...");

  for (const v of validators) {
    await prisma.validator.upsert({
      where: { pubkey: v.pubkey },
      update: v,
      create: v,
    });
  }

  // Seed initial protocol metrics
  await prisma.protocolMetrics.create({
    data: {
      totalStaked: BigInt(155_000_0000000),
      totalSupply: BigInt(155_000_0000000),
      tvlUsd: 155_000 * 0.12, // ~$0.12/XLM
      avgValidatorScore: 0.944,
    },
  });

  // Seed initial reward snapshot
  await prisma.rewardSnapshot.create({
    data: {
      totalStaked: BigInt(155_000_0000000),
      totalSupply: BigInt(155_000_0000000),
      exchangeRate: 1.0,
      apy: 4.5,
    },
  });

  console.log("Seeding complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
