import { keywordRuleSetsOf } from "../domain/keyword-config";
import type { IssueType, KeywordGroup, KeywordRuleSet, KeywordTerm } from "../domain/types";
import { keywordGroupsOf, type AppConfig } from "../seed";

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

type EnabledTermRule = {
  ruleSet: KeywordRuleSet;
  term: KeywordTerm;
};

function enabledRules(keywordGroups?: KeywordGroup[]): EnabledTermRule[] {
  return (keywordGroups ?? [])
    .filter((group) => group.enabled)
    .flatMap((group) => keywordRuleSetsOf(group)
      .filter((ruleSet) => ruleSet.enabled)
      .flatMap((ruleSet) => ruleSet.terms
        .filter((term) => term.enabled)
        .map((term) => ({ ruleSet, term }))))
    .sort((a, b) => b.ruleSet.priority - a.ruleSet.priority);
}

function matchesRule(text: string, ruleSet: KeywordRuleSet, term: KeywordTerm) {
  const normalizedText = normalize(text);
  const keyword = normalize(term.value);
  if (!keyword) return false;
  if (ruleSet.matchType === "exact" && normalizedText === keyword) return true;
  if (ruleSet.matchType === "contains" && normalizedText.includes(keyword)) return true;
  return (term.aliases ?? []).some((alias) => {
    const normalizedAlias = normalize(alias);
    if (!normalizedAlias) return false;
    return ruleSet.matchType === "exact" ? normalizedText === normalizedAlias : normalizedText.includes(normalizedAlias);
  });
}

export function hasKeywordOperationalIntent(text: string, imageUrls: string[], keywordGroups?: KeywordGroup[]) {
  const normalizedText = normalize(text);
  if (imageUrls.length > 0 && normalizedText) return true;
  return enabledRules(keywordGroups).some(({ ruleSet, term }) => (
    (ruleSet.action === "operational-intent" || ruleSet.action === "issue-type") && matchesRule(normalizedText, ruleSet, term)
  ));
}

export function detectKeywordIssueType(text: string, issueTypes: IssueType[], keywordGroups?: KeywordGroup[]) {
  const enabledIssueNames = new Set(issueTypes.filter((item) => item.enabled).map((item) => item.name));
  const rule = enabledRules(keywordGroups).find(({ ruleSet, term }) => (
    ruleSet.action === "issue-type"
    && ruleSet.issueType
    && enabledIssueNames.has(ruleSet.issueType)
    && matchesRule(text, ruleSet, term)
  ));
  return rule?.ruleSet.issueType;
}

export function keywordGroupsForConfig(config: AppConfig) {
  return keywordGroupsOf(config);
}
