import "server-only";
import { prisma } from "@/lib/prisma";

export type ProjectRole = "OWNER" | "EDITOR" | "VIEWER";

export interface ProjectMemberInfo {
  id: string;
  projectId: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
  role: ProjectRole;
  invitedAt: string;
  joinedAt: string;
}

/**
 * Resolves a user's role on a project.
 * Returns null if the user has no access.
 */
export async function getProjectRole(userId: string, projectId: string): Promise<ProjectRole | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  });

  if (!project) return null;
  if (project.userId === userId) return "OWNER";

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });

  return (member?.role as ProjectRole) ?? null;
}

/**
 * Checks whether a user has at least the required role on a project.
 */
export async function checkProjectAccess(
  userId: string,
  projectId: string,
  minRole: ProjectRole = "VIEWER"
): Promise<{ allowed: boolean; role: ProjectRole | null }> {
  const role = await getProjectRole(userId, projectId);
  if (!role) return { allowed: false, role: null };

  const roleHierarchy: Record<ProjectRole, number> = {
    OWNER: 3,
    EDITOR: 2,
    VIEWER: 1,
  };

  const allowed = roleHierarchy[role] >= roleHierarchy[minRole];
  return { allowed, role };
}

/**
 * Lists all members of a project.
 */
export async function listProjectMembers(userId: string, projectId: string): Promise<ProjectMemberInfo[]> {
  const { allowed } = await checkProjectAccess(userId, projectId, "VIEWER");
  if (!allowed) throw new Error("Unauthorized to view project members.");

  const [project, members] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
    }),
    prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  ]);

  if (!project) return [];

  const out: ProjectMemberInfo[] = [
    {
      id: `owner:${project.userId}`,
      projectId,
      userId: project.userId,
      userName: project.user.name,
      userEmail: project.user.email,
      userImage: project.user.image,
      role: "OWNER",
      invitedAt: project.createdAt.toISOString(),
      joinedAt: project.createdAt.toISOString(),
    },
  ];

  for (const m of members) {
    if (m.userId === project.userId) continue;
    out.push({
      id: m.id,
      projectId: m.projectId,
      userId: m.userId,
      userName: m.user.name,
      userEmail: m.user.email,
      userImage: m.user.image,
      role: m.role as ProjectRole,
      invitedAt: m.invitedAt.toISOString(),
      joinedAt: m.joinedAt.toISOString(),
    });
  }

  return out;
}

/**
 * Adds or updates a project member by email or user ID.
 */
export async function addProjectMember(
  actorUserId: string,
  projectId: string,
  emailOrUserId: string,
  role: ProjectRole = "EDITOR"
): Promise<ProjectMemberInfo> {
  const { allowed, role: actorRole } = await checkProjectAccess(actorUserId, projectId, "OWNER");
  if (!allowed || actorRole !== "OWNER") {
    throw new Error("Only project owners can manage members.");
  }

  // Look up user by email or id
  const targetUser = await prisma.user.findFirst({
    where: {
      OR: [{ id: emailOrUserId }, { email: emailOrUserId.toLowerCase().trim() }],
    },
    select: { id: true, name: true, email: true, image: true },
  });

  if (!targetUser) {
    throw new Error("User not found.");
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Project not found.");
  if (targetUser.id === project.userId) {
    throw new Error("Cannot add project owner as a member.");
  }

  const member = await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId, userId: targetUser.id } },
    create: {
      projectId,
      userId: targetUser.id,
      role,
    },
    update: {
      role,
    },
  });

  return {
    id: member.id,
    projectId: member.projectId,
    userId: member.userId,
    userName: targetUser.name,
    userEmail: targetUser.email,
    userImage: targetUser.image,
    role: member.role as ProjectRole,
    invitedAt: member.invitedAt.toISOString(),
    joinedAt: member.joinedAt.toISOString(),
  };
}

/**
 * Removes a member from a project.
 */
export async function removeProjectMember(
  actorUserId: string,
  projectId: string,
  targetUserId: string
): Promise<boolean> {
  const { allowed } = await checkProjectAccess(actorUserId, projectId, "OWNER");
  // A user can remove themselves (leave), or the owner can remove any member
  if (!allowed && actorUserId !== targetUserId) {
    throw new Error("Unauthorized to remove member.");
  }

  const deleted = await prisma.projectMember.deleteMany({
    where: { projectId, userId: targetUserId },
  });

  return deleted.count > 0;
}
