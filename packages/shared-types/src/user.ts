export type UserPlan = 'free' | 'basic' | 'pro' | 'flagship' | 'enterprise';
export type EntitlementSource = 'internal_beta' | 'marketplace';
export type EntitlementAccessStatus = 'active' | 'suspended';

export interface User {
  id: string;
  phone?: string;
  wechatUnionId?: string;
  nickname: string;
  avatarUrl?: string;
  plan: UserPlan;
  entitlementSource: EntitlementSource;
  accessStatus: EntitlementAccessStatus;
  entitlementRevision: number;
  status: 'active' | 'disabled';
  createdAt: Date;
}

export interface Subscription {
  id: string;
  userId: string;
  plan: Exclude<UserPlan, 'free'>;
  startDate: Date;
  endDate: Date;
  amountCny: number;
  status: 'active' | 'expired' | 'cancelled';
}
