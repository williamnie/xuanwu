export type ApprovalPolicyCacheSnapshot = {
  available: boolean;
  git_read_only_subcommands: readonly string[];
  package_managers: readonly string[];
  package_scripts: readonly string[];
  read_only_commands: readonly string[];
  small_file_change_max_paths: number;
  typecheck_commands: readonly string[];
  unavailable_reason?: string;
};

export const APPROVAL_SMALL_FILE_CHANGE_MAX_PATHS = 10;

const DEFAULT_APPROVAL_POLICY_CACHE: ApprovalPolicyCacheSnapshot = {
  available: true,
  git_read_only_subcommands: ["status", "diff", "log", "show"],
  package_managers: ["bun", "bunx", "npm", "npx", "pnpm", "pnpx", "yarn"],
  package_scripts: ["test", "lint", "build", "typecheck"],
  read_only_commands: ["cat", "file", "find", "grep", "head", "ls", "pwd", "rg", "sed", "stat", "tail", "wc"],
  small_file_change_max_paths: APPROVAL_SMALL_FILE_CHANGE_MAX_PATHS,
  typecheck_commands: ["tsc", "vue-tsc"]
};

export function approvalPolicyCacheSnapshot(): ApprovalPolicyCacheSnapshot {
  return copyApprovalPolicyCache(DEFAULT_APPROVAL_POLICY_CACHE);
}

export function unavailableApprovalPolicyCache(reason = "policy cache unavailable"): ApprovalPolicyCacheSnapshot {
  return {
    ...copyApprovalPolicyCache(DEFAULT_APPROVAL_POLICY_CACHE),
    available: false,
    unavailable_reason: reason
  };
}

function copyApprovalPolicyCache(cache: ApprovalPolicyCacheSnapshot): ApprovalPolicyCacheSnapshot {
  return {
    ...cache,
    git_read_only_subcommands: [...cache.git_read_only_subcommands],
    package_managers: [...cache.package_managers],
    package_scripts: [...cache.package_scripts],
    read_only_commands: [...cache.read_only_commands],
    typecheck_commands: [...cache.typecheck_commands]
  };
}
