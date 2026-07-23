// services/credit.service.ts
// Call deductCredit() right before actually sending an SMS/WhatsApp message,
// so a failed send doesn't burn a credit (deduct only on confirmed dispatch).

import { prisma } from '../lib/prisma.js';
import { CreditType } from '@prisma/client';

export class CreditError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function deductCredit(schoolId: number, type: CreditType, count = 1) {
  const wallet = await prisma.creditWallet.findFirst({
    where: { schoolSubscription: { schoolId } },
  });

  if (!wallet) throw new CreditError('NO_WALLET', 'No credit wallet found for this school.');

  const balanceField = type === 'SMS' ? 'smsBalance' : 'whatsappBalance';

  if ((wallet as any)[balanceField] < count) {
    throw new CreditError(
      'INSUFFICIENT_CREDITS',
      `Not enough ${type} credits remaining. Please top-up or upgrade your plan.`
    );
  }

  await prisma.$transaction([
    prisma.creditWallet.update({
      where: { id: wallet.id },
      data: { [balanceField]: { decrement: count } },
    }),
    prisma.creditTransaction.create({
      data: {
        walletId: wallet.id,
        type,
        amount: -count,
        reason: `${type.toLowerCase()}_sent`,
      },
    }),
  ]);
}

// Called by your payment-gateway webhook after a successful top-up purchase.
export async function addTopupCredits(schoolId: number, type: CreditType, count: number) {
  const wallet = await prisma.creditWallet.findFirst({
    where: { schoolSubscription: { schoolId } },
  });

  if (!wallet) throw new CreditError('NO_WALLET', 'No credit wallet found for this school.');

  const balanceField = type === 'SMS' ? 'smsBalance' : 'whatsappBalance';

  await prisma.$transaction([
    prisma.creditWallet.update({
      where: { id: wallet.id },
      data: { [balanceField]: { increment: count } },
    }),
    prisma.creditTransaction.create({
      data: {
        walletId: wallet.id,
        type,
        amount: count,
        reason: 'topup_purchase',
      },
    }),
  ]);
}

export async function getCreditBalance(schoolId: number) {
  const wallet = await prisma.creditWallet.findFirst({
    where: { schoolSubscription: { schoolId } },
  });
  if (!wallet) throw new CreditError('NO_WALLET', 'No credit wallet found for this school.');

  return { sms: wallet.smsBalance, whatsapp: wallet.whatsappBalance };
}