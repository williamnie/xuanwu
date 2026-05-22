export function sortIssuesByIdDesc(issues) {
  return [...issues].sort((left, right) => Number(right.id) - Number(left.id));
}
