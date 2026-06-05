import type { KeywordGroup, KeywordRule, KeywordRuleSet, KeywordTerm } from "./types";

function ruleSignature(rule: KeywordRule) {
  return [
    rule.matchType,
    rule.action,
    rule.issueType ?? "",
    String(rule.priority),
    rule.enabled ? "enabled" : "disabled"
  ].join("|");
}

function normalizeTerm(term: KeywordTerm, index: number): KeywordTerm {
  return {
    ...term,
    value: term.value.trim(),
    aliases: term.aliases?.map((alias) => alias.trim()).filter(Boolean),
    enabled: term.enabled,
    sortOrder: term.sortOrder ?? index + 1
  };
}

function normalizeRuleSet(ruleSet: KeywordRuleSet, index: number): KeywordRuleSet {
  return {
    ...ruleSet,
    sortOrder: ruleSet.sortOrder ?? index + 1,
    terms: (ruleSet.terms ?? [])
      .map((term, termIndex) => normalizeTerm(term, termIndex))
      .filter((term) => term.value)
  };
}

function legacyRulesToRuleSets(group: KeywordGroup): KeywordRuleSet[] {
  const buckets = new Map<string, { template: KeywordRule; terms: KeywordTerm[]; firstIndex: number }>();
  for (const [index, rule] of (group.rules ?? []).entries()) {
    const key = ruleSignature(rule);
    const existing = buckets.get(key);
    const term: KeywordTerm = {
      id: rule.id,
      value: rule.keyword,
      enabled: rule.enabled,
      sortOrder: index + 1
    };
    if (existing) {
      existing.terms.push(term);
      continue;
    }
    buckets.set(key, { template: rule, terms: [term], firstIndex: index });
  }

  return Array.from(buckets.values()).map(({ template, terms, firstIndex }, index) => ({
    id: `${group.id}-rule-set-${index + 1}`,
    matchType: template.matchType,
    action: template.action,
    issueType: template.issueType,
    priority: template.priority,
    enabled: template.enabled,
    sortOrder: firstIndex + 1,
    terms
  }));
}

export function keywordRuleSetsOf(group: KeywordGroup): KeywordRuleSet[] {
  if (group.ruleSets?.length) {
    return group.ruleSets.map((ruleSet, index) => normalizeRuleSet(ruleSet, index));
  }
  return legacyRulesToRuleSets(group);
}

export function normalizeKeywordGroups(keywordGroups?: KeywordGroup[]): KeywordGroup[] {
  return (keywordGroups ?? []).map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    enabled: group.enabled,
    ruleSets: keywordRuleSetsOf(group)
  }));
}
