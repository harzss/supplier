export type UserPlan = 'free' | 'basic' | 'pro' | 'flagship' | 'enterprise';

export interface User {
  id: string;
  phone?: string;
  wechatUnionId?: string;
  nickname: string;
  avatarUrl?: string;
  plan: UserPlan;
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
