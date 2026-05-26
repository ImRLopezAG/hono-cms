import type { HealthStatus } from "./types/providers";

export type OrganizationRecord = {
  id: string;
  name: string;
  slug: string;
  plan?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type OrganizationUpdateInput = {
  name: string;
  slug: string;
  plan?: string;
};

export type OrganizationMemberStatus = "active" | "pending" | "disabled";

export type OrganizationMember = {
  id: string;
  email: string;
  name?: string;
  role: string;
  status: OrganizationMemberStatus;
  joinedAt?: string;
};

export type OrganizationMemberUpdateInput = {
  role: string;
  status: OrganizationMemberStatus;
};

export type OrganizationInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export type OrganizationInvitation = {
  id: string;
  email: string;
  role: string;
  status: OrganizationInvitationStatus;
  expiresAt?: string;
  createdAt?: string;
};

export type OrganizationInvitationInput = {
  email: string;
  role: string;
};

export type OrganizationStore = {
  getOrganization(): Promise<OrganizationRecord>;
  updateOrganization(input: OrganizationUpdateInput): Promise<OrganizationRecord>;
  listMembers(): Promise<OrganizationMember[]>;
  updateMember(id: string, input: OrganizationMemberUpdateInput): Promise<OrganizationMember>;
  removeMember(id: string): Promise<OrganizationMember | null>;
  listInvitations(): Promise<OrganizationInvitation[]>;
  createInvitation(input: OrganizationInvitationInput): Promise<OrganizationInvitation>;
  revokeInvitation(id: string): Promise<OrganizationInvitation>;
  health?(): Promise<HealthStatus>;
};

export class MemoryOrganizationStore implements OrganizationStore {
  private organization: OrganizationRecord;
  private readonly members = new Map<string, OrganizationMember>();
  private readonly invitations = new Map<string, OrganizationInvitation>();

  constructor(input: {
    organization?: OrganizationRecord;
    members?: readonly OrganizationMember[];
    invitations?: readonly OrganizationInvitation[];
  } = {}) {
    const now = new Date().toISOString();
    this.organization = cloneOrganization(input.organization ?? {
      id: "org_default",
      name: "Default Organization",
      slug: "default",
      plan: "development",
      createdAt: now,
      updatedAt: now
    });
    for (const member of input.members ?? []) this.members.set(member.id, cloneMember(member));
    for (const invitation of input.invitations ?? []) this.invitations.set(invitation.id, cloneInvitation(invitation));
  }

  async getOrganization(): Promise<OrganizationRecord> {
    return cloneOrganization(this.organization);
  }

  async updateOrganization(input: OrganizationUpdateInput): Promise<OrganizationRecord> {
    this.organization = {
      ...this.organization,
      name: input.name,
      slug: input.slug,
      ...(input.plan ? { plan: input.plan } : {}),
      updatedAt: new Date().toISOString()
    };
    return cloneOrganization(this.organization);
  }

  async listMembers(): Promise<OrganizationMember[]> {
    return [...this.members.values()].map(cloneMember);
  }

  async updateMember(id: string, input: OrganizationMemberUpdateInput): Promise<OrganizationMember> {
    const existing = this.members.get(id);
    if (!existing) throw new Error(`organization member not found: ${id}`);
    const next = { ...existing, role: input.role, status: input.status };
    this.members.set(id, next);
    return cloneMember(next);
  }

  async removeMember(id: string): Promise<OrganizationMember | null> {
    const existing = this.members.get(id);
    if (!existing) return null;
    this.members.delete(id);
    return cloneMember(existing);
  }

  async listInvitations(): Promise<OrganizationInvitation[]> {
    return [...this.invitations.values()].map(cloneInvitation);
  }

  async createInvitation(input: OrganizationInvitationInput): Promise<OrganizationInvitation> {
    const now = new Date().toISOString();
    const invitation: OrganizationInvitation = {
      id: `invite_${crypto.randomUUID()}`,
      email: input.email,
      role: input.role,
      status: "pending",
      createdAt: now
    };
    this.invitations.set(invitation.id, invitation);
    return cloneInvitation(invitation);
  }

  async revokeInvitation(id: string): Promise<OrganizationInvitation> {
    const existing = this.invitations.get(id);
    if (!existing) throw new Error(`organization invitation not found: ${id}`);
    const next = { ...existing, status: "revoked" as const };
    this.invitations.set(id, next);
    return cloneInvitation(next);
  }

  async health(): Promise<HealthStatus> {
    return { ok: true, details: { members: this.members.size, invitations: this.invitations.size } };
  }
}

function cloneOrganization(record: OrganizationRecord): OrganizationRecord {
  return { ...record };
}

function cloneMember(record: OrganizationMember): OrganizationMember {
  return { ...record };
}

function cloneInvitation(record: OrganizationInvitation): OrganizationInvitation {
  return { ...record };
}
