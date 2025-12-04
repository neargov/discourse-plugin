# Test Health Checklist

Quick assessment to score the health of a test suite during code review or test audit.

---

## 1. Individual Test Quality

### FIRST Principles

| Check | Principle | Pass/Fail |
|-------|-----------|-----------|
| [ ] | Fast — Unit tests complete in <100ms each | |
| [ ] | Isolated — No dependencies on other tests or execution order | |
| [ ] | Repeatable — Same result every run, any environment | |
| [ ] | Self-validating — Clear pass/fail, no manual inspection needed | |
| [ ] | Timely — Written close to the code, ideally before (TDD) | |

### Structure

| Check | Criteria | Pass/Fail |
|-------|----------|-----------|
| [ ] | Clear Arrange-Act-Assert structure | |
| [ ] | Single logical assertion per test (one reason to fail) | |
| [ ] | Descriptive test name: MethodName_Scenario_ExpectedBehavior | |
| [ ] | Can understand test without reading implementation | |
| [ ] | No logic in test (no if/else, loops, try/catch) | |

### Characteristics

| Good | Check | Bad |
|------|-------|-----|
| Fast | [ ] | Slow |
| Isolated | [ ] | Coupled |
| Repeatable | [ ] | Flaky |
| Focused | [ ] | Broad/Sprawling |
| Readable | [ ] | Obscure |
| Maintainable | [ ] | Fragile |
| Self-contained | [ ] | Dependent |
| Deterministic | [ ] | Non-deterministic |

---

## 2. Test Smell Detection

### Critical Smells (Fix Immediately)

| Smell | Check | How to Detect |
|-------|-------|---------------|
| [ ] | Flaky test | Passes sometimes, fails other times without code changes |
| [ ] | Liar test | Test passes but assertions do not verify actual behavior |
| [ ] | Under-mocking | Hits real external services (network, database, APIs) |
| [ ] | Test pollution | Tests affect each other through shared state |
| [ ] | Dead test | Skipped, disabled, or never runs in CI |

### High Priority Smells (Fix This Sprint)

| Smell | Check | How to Detect |
|-------|-------|---------------|
| [ ] | Brittle test | Breaks when implementation changes (but behavior does not) |
| [ ] | Happy path only | No tests for error cases, edge cases, or boundaries |
| [ ] | Coupled test | Depends on other tests running first |
| [ ] | Over-mocking | So many mocks that nothing real is tested |
| [ ] | Slow test | Unit tests >100ms, integration tests >5s |

### Medium Priority Smells (Fix When Touching)

| Smell | Check | How to Detect |
|-------|-------|---------------|
| [ ] | Magic numbers | Unexplained values: expect(result).toBe(42) |
| [ ] | Eager test | Single test verifying too many unrelated things |
| [ ] | Assertion roulette | Multiple assertions, unclear which failed |
| [ ] | Mystery guest | Depends on external files/data not visible in test |
| [ ] | General fixture | Massive beforeEach setup, most tests do not need it all |

### Low Priority Smells (Nice to Fix)

| Smell | Check | How to Detect |
|-------|-------|---------------|
| [ ] | Test duplication | Same scenario tested multiple times |
| [ ] | Obscure test | Hard to understand what is being tested |
| [ ] | Sensitive equality | Comparing entire objects when one field matters |
| [ ] | Shotgun surgery | One change requires updating many tests |
| [ ] | Commented test | Test commented out "temporarily" |

---

## 3. Coverage Analysis

### Coverage Metrics

| Metric | Current | Target | Check |
|--------|---------|--------|-------|
| Line coverage | ___% | >80% | [ ] |
| Branch coverage | ___% | >70% | [ ] |
| Function coverage | ___% | >90% | [ ] |
| Critical path coverage | ___% | 100% | [ ] |

### Coverage Quality

| Check | Criteria | Pass/Fail |
|-------|----------|-----------|
| [ ] | No test deserts in critical code paths | |
| [ ] | Error handling paths covered | |
| [ ] | Edge cases and boundaries covered | |
| [ ] | Not over-tested on trivial code | |
| [ ] | Branch coverage matters, not just line coverage | |

### Coverage Anti-Patterns

| Check | Anti-Pattern |
|-------|--------------|
| [ ] | Tests written just to hit coverage numbers (low value) |
| [ ] | 100% coverage but missing important scenarios |
| [ ] | Covering getters/setters but not business logic |
| [ ] | High coverage but all happy path, no error cases |

---

## 4. Test Pyramid Health

### Distribution

| Layer | Current % | Target % | Check |
|-------|-----------|----------|-------|
| Unit tests | ___% | 70% | [ ] |
| Integration tests | ___% | 20% | [ ] |
| E2E tests | ___% | 10% | [ ] |

### Pyramid Anti-Patterns

| Check | Pattern | Problem |
|-------|---------|---------|
| [ ] | Ice cream cone | More E2E than unit tests |
| [ ] | Hourglass | Missing integration layer |
| [ ] | No pyramid | Only one type of test |

---

## 5. Test Reliability

### Stability Metrics

| Metric | Value | Target | Check |
|--------|-------|--------|-------|
| Flaky test rate | ___% | <1% | [ ] |
| Average test duration | ___s | <10s suite | [ ] |
| CI failure rate (non-code) | ___% | <5% | [ ] |
| Tests in quarantine | ___ | 0 | [ ] |

### Reliability Characteristics

| Check | Criteria | Pass/Fail |
|-------|----------|-----------|
| [ ] | No Heisenbugs (bugs that disappear when debugging) | |
| [ ] | No flickers (occasional unexplained failures) | |
| [ ] | No cascade failures (one failure causes others) | |
| [ ] | CI is green path (failures indicate real issues) | |

---

## 6. Test Maintenance

### Maintenance Health

| Check | Criteria | Pass/Fail |
|-------|----------|-----------|
| [ ] | No significant test rot (outdated tests) | |
| [ ] | Minimal test debt (shortcuts accumulating) | |
| [ ] | Tests updated when requirements change | |
| [ ] | Dead/skipped tests removed or fixed | |
| [ ] | Test code gets same review quality as production code | |

### Refactoring Resilience

| Check | Criteria | Pass/Fail |
|-------|----------|-----------|
| [ ] | Tests survive internal refactoring | |
| [ ] | Tests only fail when behavior changes | |
| [ ] | Tests do not depend on implementation details | |
| [ ] | Changing one feature does not break unrelated tests | |

---

## 7. Test Types Coverage

### Essential Test Types Present

| Type | Present | Purpose |
|------|---------|---------|
| [ ] | Unit tests | Test individual functions in isolation |
| [ ] | Integration tests | Test component interactions |
| [ ] | Smoke tests | Quick sanity check system works |
| [ ] | Regression tests | Verify old bugs stay fixed |

### Recommended Test Types

| Type | Present | When Needed |
|------|---------|-------------|
| [ ] | Contract tests | API boundaries between services |
| [ ] | Property-based tests | Complex logic with many edge cases |
| [ ] | Characterization tests | Legacy code documentation |
| [ ] | Golden/snapshot tests | UI or output stability |

---

## 8. Mocking Health

### Mocking Balance

| Check | Criteria | Pass/Fail |
|-------|----------|-----------|
| [ ] | External services mocked (network, DB, APIs) | |
| [ ] | Not over-mocking internal collaborators | |
| [ ] | Mocks reflect real behavior | |
| [ ] | Mock setup is readable and maintainable | |

### Mocking Anti-Patterns

| Check | Anti-Pattern |
|-------|--------------|
| [ ] | Mocking everything (nothing real tested) |
| [ ] | Mocking nothing (slow, flaky, network-dependent) |
| [ ] | Mocks that do not match real API behavior |
| [ ] | Mocks that never get updated when API changes |

---

## 9. Failure Analysis

### When Tests Fail

| Check | Criteria | Pass/Fail |
|-------|----------|-----------|
| [ ] | Failure message clearly indicates what is wrong | |
| [ ] | Can identify root cause versus symptom | |
| [ ] | No cascade failures obscuring real issue | |
| [ ] | Failures are true positives (not false positives) | |

### Failure Anti-Patterns

| Check | Anti-Pattern |
|-------|--------------|
| [ ] | False positives: Tests fail but code is correct |
| [ ] | False negatives: Tests pass but code is broken |
| [ ] | Failures require debugging to understand | |
| [ ] | Same failure causes multiple tests to fail | |

---

## 10. Quick Scoring

### Per-Test Score

```
For each test, score 0-2:
- 2: Meets criteria
- 1: Partially meets
- 0: Does not meet

[ ] Fast (< 100ms)           ___
[ ] Isolated                 ___
[ ] Repeatable               ___
[ ] Single assertion focus   ___
[ ] Readable name/structure  ___
[ ] Tests behavior not impl  ___

Total: ___/12
- 10-12: Excellent
- 7-9: Good
- 4-6: Needs work
- 0-3: Rewrite
```

### Suite Health Score

```
[ ] Coverage > 80%                    ___/10
[ ] No flaky tests                    ___/10
[ ] Correct pyramid shape             ___/10
[ ] No critical smells                ___/10
[ ] Fast CI (<5 min)                  ___/10
[ ] All test types present            ___/10
[ ] Good mocking balance              ___/10
[ ] Failures are actionable           ___/10
[ ] Maintained and current            ___/10
[ ] Survives refactoring              ___/10

Total: ___/100
- 90-100: Excellent
- 70-89: Good
- 50-69: Needs improvement
- <50: Major overhaul needed
```

---

## Review Workflow

### Before Approving PR

```
1. [ ] New code has tests
2. [ ] Tests cover happy path AND error cases
3. [ ] No new test smells introduced
4. [ ] Coverage did not decrease
5. [ ] Tests are readable without implementation context
6. [ ] CI passes consistently (not flaky)
```

### Weekly Test Health Check

```
1. [ ] Review flaky test rate
2. [ ] Check for new test deserts
3. [ ] Audit skipped/disabled tests
4. [ ] Review slowest tests
5. [ ] Check coverage trends
```

### Quarterly Test Audit

```
1. [ ] Full smell detection sweep
2. [ ] Coverage gap analysis
3. [ ] Test pyramid rebalancing
4. [ ] Dead test cleanup
5. [ ] Test infrastructure review
```

