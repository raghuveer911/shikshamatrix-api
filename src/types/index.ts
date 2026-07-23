export interface JwtPayload {
  userId: number;
  schoolId: number;
  role: string;
  schoolName: string;
  userName: string;
}

export interface SuperAdminJwtPayload {
  superAdminId: number;
  email: string;
  isSuperAdmin: true;
}

export interface AgentJwtPayload {
  agentId: number;
  username: string;
  isAgent: true;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}