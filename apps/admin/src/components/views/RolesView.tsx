import { useQuery } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef
} from "@tanstack/react-table";
import { useMemo, type ReactElement } from "react";
import type { RBACAction, RBACMatrix, RBACMatrixCollection, RBACMatrixRule } from "../../lib/api-client";
import { SettingsShell } from "./SettingsShell";
import { useClient } from "./shared";

const RBAC_ACTIONS: readonly RBACAction[] = ["create", "read", "update", "delete", "publish"];

const ACTION_LABEL: Record<RBACAction, string> = {
  create: "Create",
  read: "Read",
  update: "Update",
  delete: "Delete",
  publish: "Publish"
};

type MatrixRow = {
  name: string;
  publicActions: Set<RBACAction>;
  authenticatedActions: Set<RBACAction>;
  rolesByAction: Record<RBACAction, string[]>;
};

/**
 * Read-only viewer over the static `cms.config.rbac` configuration. Roles
 * in Hono CMS are strings declared in code; there is no roles table, so
 * this surface deliberately exposes no create/update/delete affordances.
 *
 * The matrix:
 *   - top: known roles rendered as chips (matches Strapi's "Roles & permissions"
 *     overview palette: `bg-[#f0f0ff] text-[#4945ff]`).
 *   - middle: `@tanstack/react-table` grid with one row per collection and
 *     one column per action. Each cell lists the roles that are explicitly
 *     allowed by `cms.config.rbac.rules`, plus the per-collection escape
 *     hatches (`options.rbac.public`, `options.rbac.authenticated`).
 */
export function RolesView(): ReactElement {
  const client = useClient();
  const query = useQuery({ queryKey: ["rbac-matrix"], queryFn: () => client.rbacMatrix() });
  const matrix = query.data;

  const rows = useMemo(() => (matrix ? buildMatrixRows(matrix) : []), [matrix]);
  const columns = useMemo<ColumnDef<MatrixRow>[]>(() => {
    const head: ColumnDef<MatrixRow> = {
      id: "collection",
      header: () => <span>Collection</span>,
      cell: (info) => (
        <span className="font-medium text-[#32324d]">{info.row.original.name}</span>
      )
    };
    const actionColumns = RBAC_ACTIONS.map<ColumnDef<MatrixRow>>((action) => ({
      id: action,
      header: () => <span>{ACTION_LABEL[action]}</span>,
      cell: (info) => <ActionCell row={info.row.original} action={action} />
    }));
    return [head, ...actionColumns];
  }, []);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  const hasRules = (matrix?.rules?.length ?? 0) > 0;
  const hasOverrides = rows.some((row) => row.publicActions.size > 0 || row.authenticatedActions.size > 0);
  const showEmptyState = matrix !== undefined && !hasRules && !hasOverrides;

  const subtitle = query.isLoading
    ? "Loading effective permissions…"
    : query.isError
      ? "Could not load the role matrix."
      : "Effective access control across collections.";

  return (
    <SettingsShell
      eyebrow="Security"
      title="Roles & Permissions"
      subtitle={subtitle}
      action={matrix?.publicRead ? <PublicReadBadge /> : null}
    >
      {matrix ? <RolesChips roles={matrix.roles} /> : null}

      {showEmptyState ? (
        <EmptyState />
      ) : matrix ? (
        <div className="overflow-hidden rounded-lg border border-[#eaeaef] bg-white shadow-sm">
          <table className="w-full border-collapse text-[13px]" aria-label="Effective role permissions by collection">
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id} className="border-b border-[#eaeaef] bg-[#f6f6f9]">
                  {group.headers.map((header) => (
                    <th
                      key={header.id}
                      scope="col"
                      className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]"
                    >
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="border-b border-[#eaeaef] last:border-b-0 hover:bg-[#f6f6f9]">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-5 py-3 align-top text-[#32324d]">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </SettingsShell>
  );
}

function RolesChips({ roles }: { roles: string[] }): ReactElement {
  return (
    <div className="rounded-lg border border-[#eaeaef] bg-white p-4 shadow-sm">
      <p className="m-0 mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">
        Known roles
      </p>
      <div className="flex flex-wrap gap-2">
        {roles.map((role) => (
          <span
            key={role}
            className="inline-flex items-center rounded-full bg-[#f0f0ff] px-2.5 py-0.5 text-[12px] font-medium text-[#4945ff]"
            aria-label={`Role: ${role}`}
          >
            {role}
          </span>
        ))}
      </div>
    </div>
  );
}

function PublicReadBadge(): ReactElement {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-[#f0f0c2] px-2.5 py-0.5 text-[11px] font-medium text-[#8a7a00]"
      title="config.rbac.publicRead is enabled — unauthenticated requests can read every collection."
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      Public read enabled
    </span>
  );
}

function ActionCell({ row, action }: { row: MatrixRow; action: RBACAction }): ReactElement {
  const ruleRoles = row.rolesByAction[action] ?? [];
  const isPublic = row.publicActions.has(action);
  const isAuthenticated = row.authenticatedActions.has(action);

  if (ruleRoles.length === 0 && !isPublic && !isAuthenticated) {
    return <span className="text-[#8e8ea9]">—</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {isPublic ? <Badge tone="public">public</Badge> : null}
      {isAuthenticated ? <Badge tone="authenticated">authenticated</Badge> : null}
      {ruleRoles.map((role) => (
        <Badge key={role} tone="role">{role}</Badge>
      ))}
    </div>
  );
}

function Badge({ tone, children }: { tone: "role" | "public" | "authenticated"; children: string }): ReactElement {
  const className = tone === "public"
    ? "inline-flex items-center rounded-full bg-[#c6f0c2] px-2 py-0.5 text-[11px] font-medium text-[#328048]"
    : tone === "authenticated"
      ? "inline-flex items-center rounded-full bg-[#fce9d0] px-2 py-0.5 text-[11px] font-medium text-[#d9822b]"
      : "inline-flex items-center rounded-full bg-[#f0f0ff] px-2 py-0.5 text-[11px] font-medium text-[#4945ff]";
  return <span className={className}>{children}</span>;
}

function EmptyState(): ReactElement {
  return (
    <div className="rounded-lg border border-dashed border-[#eaeaef] bg-white p-8 text-center shadow-sm">
      <p className="m-0 mb-1 text-[14px] font-medium text-[#32324d]">
        No RBAC rules configured
      </p>
      <p className="m-0 max-w-[48ch] mx-auto text-[13px] text-[#8e8ea9]">
        All authenticated users have full access via the <code className="rounded bg-[#f6f6f9] px-1 py-0.5 font-mono text-[12px] text-[#4945ff]">admin</code> role.
      </p>
    </div>
  );
}

function buildMatrixRows(matrix: RBACMatrix): MatrixRow[] {
  const rulesByCollection = new Map<string, RBACMatrixRule[]>();
  for (const rule of matrix.rules) {
    const bucket = rulesByCollection.get(rule.collection) ?? [];
    bucket.push(rule);
    rulesByCollection.set(rule.collection, bucket);
  }

  return matrix.collections.map<MatrixRow>((collection) => {
    const rolesByAction = emptyRolesByAction();
    for (const rule of rulesByCollection.get(collection.name) ?? []) {
      rolesByAction[rule.action] = rule.roles;
    }
    return {
      name: collection.name,
      publicActions: new Set(collection.public),
      authenticatedActions: new Set(collection.authenticated),
      rolesByAction
    };
  });
}

function emptyRolesByAction(): Record<RBACAction, string[]> {
  return {
    create: [],
    read: [],
    update: [],
    delete: [],
    publish: []
  };
}

export type { MatrixRow };
export { RBAC_ACTIONS, buildMatrixRows };
