# نظام إدارة حالة المشروع واستمرارية العمل بين محادثات ChatGPT/Codex

> **الغرض:** هذه التعليمات هي أمر تنفيذ مباشر للمشروع. المطلوب تطبيقها فعليًا داخل المستودع، لا الاكتفاء بشرحها أو إنشاء قوالب فارغة.
>
> **المعيار:** صمّم النظام وفق ممارسات هندسة البرمجيات الحديثة: repository-native agent instructions، docs-as-code، Architecture Decision Records (ADRs)، evidence-based verification، CI/CD guardrails، runbooks، incident postmortems، وفصل واضح بين desired state وactual state.
>
> **القاعدة العليا:** لا تعتمد على ذاكرة المحادثات باعتبارها قاعدة بيانات لحالة المشروع. الذاكرة مساعدة فقط. الحقيقة يجب أن تكون قابلة للتحقق من المستودع، Git، CI/CD، وبيئة التشغيل الفعلية.

---

## 1) المهمة

نفّذ نظامًا دائمًا وموثوقًا لإدارة **حالة المشروع، القرارات، خطط العمل، التشغيل، واستمرارية التنفيذ بين المحادثات الجديدة**.

بعد تنفيذ هذا الطلب يجب أن أستطيع فتح محادثة ChatGPT/Codex جديدة لا تعرف شيئًا عن المحادثات السابقة، فتقرأ ملفات المشروع وتستطيع فورًا تحديد:

- ما الحالة الحالية للمشروع؟
- ما الفرع الفعلي الحالي؟
- ما حالة Working Tree؟
- ما الكود الذي يمثل آخر baseline متحقق منه؟
- ما النسخة أو الإصدار الفعلي إن وجد؟
- ما الحالة المطلوبة Desired State؟
- ما الحالة الفعلية Actual State؟
- ما الموجود في CI؟
- ما الموجود في Staging؟
- ما الموجود في Production؟
- هل توجد فروقات أو Drift بين Git وبيئات النشر؟
- ما الذي تم إنجازه والتحقق منه؟
- ما الذي لم يُنجز؟
- ما المشاكل والـblockers المعروفة؟
- ما القرارات التقنية المهمة ولماذا اتخذت؟
- ما الخدمات والمسارات والأوامر والمنافذ المهمة؟
- ما الاختبارات الفعلية ونتائجها؟
- ما الأشياء التي يمنع تغييرها أو يجب الحذر منها؟
- ما الخطوة التالية الدقيقة والقابلة للتنفيذ؟
- من أين يجب استئناف العمل دون إعادة تنفيذ ما اكتمل؟

الهدف أن تكون المحادثة الجديدة قادرة على الاستمرار **من الأدلة الموثقة والحالة القابلة للتحقق**، لا من استرجاع عشوائي لمحادثات قديمة.

---

# 2) مبادئ التصميم غير القابلة للتفاوض

طبّق المبادئ التالية:

1. **Repository as the durable coordination surface**  
   كل ما يلزم لاستمرار العمل يجب أن يعيش قدر الإمكان مع المستودع، لا داخل محادثة مؤقتة فقط.

2. **Single responsibility for each document**  
   لا تجعل ملفًا واحدًا يقوم بدور التعليمات والحالة والتاريخ والقرارات والتشغيل في الوقت نفسه.

3. **Verified facts over remembered facts**  
   أي معلومة يمكن التحقق منها من Git أو CI/CD أو البيئة الفعلية يجب التحقق منها بدل الاعتماد على الذاكرة.

4. **Evidence over claims**  
   لا تسجل `PASS` أو `DEPLOYED` أو `WORKING` أو SHA أو إصدارًا ما لم توجد وسيلة تحقق فعلية.

5. **Current state must stay small and current**  
   ملف الحالة الحالية ليس أرشيفًا تاريخيًا.

6. **Decisions are append-only records with lifecycle**  
   القرارات المعمارية المهمة تحفظ كـ ADRs مستقلة؛ القرار القديم لا يحذف عند استبداله بل يوسم `Superseded` ويرتبط بالقرار الجديد.

7. **Automation where practical**  
   أي قاعدة مهمة يمكن التحقق منها آليًا دون إحداث ضجيج أو تعطيل المشروع يفضّل فرضها في CI أو repository rules بدل الاعتماد على الانضباط اليدوي فقط.

8. **No duplicate truth**  
   Git هو الحقيقة للكود، CI هو الحقيقة لنتيجة خطوط البناء، ومنصة النشر/البيئة هي الحقيقة لما نُشر فعليًا. ملفات Markdown تلخص وتربط هذه الحقائق ولا تنافسها.

9. **Meaningful state transitions trigger handoff updates**  
   لا يلزم تحديث ملف الحالة لكل typo أو تعديل صغير، لكن يجب تحديثه عند كل تغير مهم في الحالة.

10. **Security by default**  
    لا تضع أسرارًا أو رموز وصول أو مفاتيح خاصة أو cookies أو credentials داخل ملفات التسليم أو السجل.

---

# 3) افحص الموجود قبل إنشاء أي ملفات

قبل إنشاء أي ملف جديد:

1. افحص جذر المستودع.
2. ابحث عن ملفات موجودة تؤدي الوظائف نفسها، مثل:
   - `AGENTS.md`
   - `CLAUDE.md`
   - `CONTRIBUTING.md`
   - `README.md`
   - `PROJECT_STATE.md`
   - `HANDOFF.md`
   - `STATUS.md`
   - `PLANS.md`
   - `CHANGELOG.md`
   - مجلد `docs/adr/`
   - مجلد `docs/runbooks/`
   - مجلد `docs/postmortems/`
3. لا تنشئ نظامًا موازيًا متعارضًا إذا كان هناك نظام صالح بالفعل.
4. وحّد القواعد المتكررة واحذف التعارضات الواضحة عندما يكون ذلك آمنًا.
5. إذا كان هناك ملف instruction تستخدمه أداة أخرى، احتفظ بالتوافق بدل حذفه بلا داعٍ، لكن اجعل المرجع الأساسي واضحًا.

---

# 4) الهيكل المستهدف

استخدم الهيكل التالي **عندما يكون مناسبًا لطبيعة المشروع**، مع إعادة استخدام الموجود بدل التكرار:

```text
/
├── AGENTS.md
├── PROJECT_STATE.md
├── PLANS.md                    # عند وجود عمل كبير/متعدد المراحل
├── CHANGELOG.md                # إذا كان المشروع يحتاج changelog بشريًا
│
├── docs/
│   ├── architecture/
│   │   └── README.md           # وصف معماري حالي عند الحاجة
│   │
│   ├── adr/
│   │   ├── README.md
│   │   ├── 0001-....md
│   │   └── 0002-....md
│   │
│   ├── runbooks/
│   │   ├── deployment.md
│   │   ├── rollback.md
│   │   ├── production-verification.md
│   │   └── incident-response.md
│   │
│   └── postmortems/
│       └── ...                 # فقط عند وجود حوادث تستحق postmortem
│
└── .github/
    └── workflows/
```

لا تنشئ كل ملف أو مجلد تلقائيًا إذا لم تكن له قيمة فعلية. استخدم **أقل بنية تحقق الهدف دون تضخم**.

---

# 5) `AGENTS.md` — التعليمات الدائمة لوكلاء البرمجة

اجعل `AGENTS.md` ملف التعليمات الدائمة الرئيسي لوكلاء ChatGPT/Codex داخل المستودع، ما لم توجد قيود تقنية مثبتة تمنع ذلك.

يجب أن يبقى **مختصرًا نسبيًا وثابتًا**، وألا يحتوي على بيانات سريعة التقادم مثل SHA الحالي أو حالة Production اللحظية.

يجب أن يغطي، بحسب المشروع:

- هدف المشروع باختصار.
- بنية المستودع المهمة.
- أوامر setup/build/test/lint/typecheck.
- قواعد Git والفروع والـcommits.
- قواعد الاختبار والتحقق قبل اعتبار المهمة مكتملة.
- قواعد النشر والبيئات.
- حماية Production.
- قواعد الأسرار والبيانات الحساسة.
- قواعد migrations والـbackward compatibility عند الحاجة.
- أسلوب التعامل مع failures.
- متى يجب تحديث `PROJECT_STATE.md`.
- متى يجب إنشاء/تحديث ADR.
- متى يجب إنشاء/تحديث runbook.
- متى يجب استخدام `PLANS.md`.
- تعريف واضح لـ **Done**.

أضف قاعدة دائمة قريبة من الآتي:

```text
At the beginning of every new work session:
1. Read AGENTS.md.
2. Read PROJECT_STATE.md.
3. Inspect the actual repository state before making changes.
4. Verify current branch, HEAD, and working tree.
5. Read the relevant ADRs when the task touches an established architectural decision.
6. Read the relevant runbook before production/deployment/rollback/incident work.
7. Use PLANS.md for long-horizon or multi-stage work when appropriate.
8. Treat conversation memory as advisory only; verified repository/runtime state takes precedence.
9. If PROJECT_STATE.md conflicts with verified reality, update it before relying on it.
10. Continue from NEXT ACTION unless the user explicitly changes priority.
```

وأضف قاعدة إكمال:

```text
No meaningful task is complete until:
- the requested change is implemented,
- applicable validation has actually run,
- failures are disclosed,
- current state documentation is updated when the project state materially changed,
- architectural decisions are recorded when applicable,
- deployment state is verified when deployment was part of the task.
```

---

# 6) `PROJECT_STATE.md` — الحالة الحالية فقط

هذا هو **الملخص التشغيلي الحالي** للمشروع، وليس سجلًا تاريخيًا ولا نسخة بديلة من Git.

يجب أن يكون:

- ذاتي الاكتفاء قدر الإمكان.
- سريع القراءة.
- خاليًا من المعلومات القديمة المتضاربة.
- قائمًا على حقائق متحقق منها.
- مناسبًا لمحادثة جديدة تريد استئناف العمل بسرعة.

استخدم بنية قريبة من التالية، واحذف الأقسام غير المناسبة للمشروع:

```markdown
# PROJECT STATE

## Metadata
- Last state update:
- State author/agent:
- Repository:

## Executive Status
- Overall status:
- Current objective:
- Current blocker:

## Repository State
- Current branch:
- Working tree: CLEAN / DIRTY / NOT VERIFIED
- Verified code baseline:
- Remote tracking state:
- Relevant release/tag:

## Uncommitted Work
- Files:
- Purpose:
- Safe to discard: YES / NO / UNKNOWN

## Desired State
- ...

## Actual State
### Repository
### CI
### Staging
### Production
### External dependencies

## Drift
- Repository ↔ CI:
- Repository ↔ Staging:
- Repository ↔ Production:
- Status: NONE / PRESENT / NOT VERIFIED

## Current Architecture
- concise description or link to docs/architecture/

## Important Paths
- ...

## Services / Components
- ...

## Ports / Endpoints
- ...

## Runtime / Environment
- ...

## Completed and Verified
- ...

## Last Verified Validation
### Build
- Command:
- Result:
- Evidence/date:

### Tests
- Command:
- Result:
- Evidence/date:

### Lint / Typecheck / Security checks
- Command:
- Result:
- Evidence/date:

### Production smoke verification
- Method:
- Result:
- Evidence/date:

## Known Issues / Blockers
- Issue/reference:
- Severity:
- Impact:
- Status:
- Workaround:
- Next required action:

## Risks
- ...

## Constraints / Invariants
- ...

## DO NOT CHANGE WITHOUT EXPLICIT REASON
- ...

## Pending Decisions
- ...

## NEXT ACTION
1. ...
2. ...

## Resume Instructions
- ...
```

---

# 7) حل مشكلة الـ SHA بطريقة صحيحة

**لا تجعل `PROJECT_STATE.md` يدعي أن قيمة ثابتة داخله هي دائمًا HEAD الحالي.**

السبب: إذا كتبت HEAD في الملف ثم commit لتحديث الملف نفسه، يتغير HEAD فورًا وقد يصبح السجل قديمًا ذاتيًا.

استخدم واحدة من الطريقتين التاليتين:

### الطريقة المفضلة

سجل:

```text
Verified code baseline: <SHA الذي تم التحقق منه فعليًا>
State-document commit: derive from Git when needed
Current HEAD: verify dynamically with git rev-parse HEAD
```

### أو

سجل بوضوح أن SHA المشار إليه هو:

```text
Last verified implementation SHA: ...
```

وليس ادعاء أنه HEAD الحالي للأبد.

عند بدء جلسة جديدة يجب دائمًا تشغيل:

```bash
git branch --show-current
git rev-parse HEAD
git status --short --branch
git log -1 --oneline
```

واستخدم `git remote -v` أو ما يعادله عند الحاجة.

---

# 8) افصل Desired State عن Actual State

لا تخلط ما **ينبغي** أن يكون منشورًا مع ما **هو منشور فعليًا**.

مثال:

```markdown
## Desired State
- Release: v2.4.1
- Expected commit: abc123...

## Actual State
### Repository
- main: abc123...

### CI
- Build: PASS
- Tests: PASS

### Production
- Reported deployed revision: abc123...
- Smoke verification: PASS
- Verified at: <timestamp>

## Drift
- Desired ↔ Production: NONE
```

إذا تعذر التحقق من Production، اكتب:

```text
Production revision: NOT VERIFIED
```

ولا تستنتج أنه مطابق لمجرد نجاح push أو merge.

**Push ≠ Merge ≠ CI pass ≠ Deploy ≠ Healthy Production.**

---

# 9) نتائج الاختبارات — سجل الأدلة لا الانطباعات

ممنوع الاكتفاء بعبارات عامة مثل:

```text
All tests passed.
Everything works.
Deployment successful.
```

بدل ذلك، عند أهمية النتيجة سجّل:

- الأمر الفعلي.
- مجموعة الاختبارات.
- النتيجة.
- عدد الاختبارات عند توفره.
- الاختبارات المتخطاة أو الفاشلة.
- تاريخ/وقت التحقق عندما يكون مهمًا.
- البيئة التي نُفذ عليها الاختبار.
- سبب عدم التنفيذ إن تعذر.

مثال:

```markdown
### Unit Tests
Command: `npm test`
Result: PASS — 148 passed, 0 failed.
Verified on: local CI-compatible environment.

### Build
Command: `npm run build`
Result: PASS.

### Email delivery
Result: NOT VERIFIED.
Reason: environment has no valid outbound email credentials.
```

لا تحول `NOT VERIFIED` إلى `PASS`.

---

# 10) `docs/adr/` — Architecture Decision Records

لا تستخدم ملف `DECISIONS.md` ضخمًا كقاعدة افتراضية للمشروع الكبير.

أنشئ ADR مستقلًا فقط للقرارات المهمة التي يصعب أو يكلف عكسها، مثل:

- اختيار أو تغيير architecture أساسي.
- authentication/session model.
- database/storage strategy.
- deployment strategy.
- API compatibility policy.
- security boundary.
- major dependency/platform selection.
- migration strategy.
- significant observability/reliability design.

صيغة ADR المقترحة:

```markdown
# ADR-000X: <Decision title>

- Status: Proposed | Accepted | Deprecated | Superseded
- Date:
- Owners:
- Supersedes:
- Superseded by:

## Context

## Decision

## Alternatives Considered

## Consequences
### Positive
### Negative / Trade-offs

## Validation / Evidence

## Related Files

## Related Issues / PRs / Commits

## Change History
```

قواعد ADR:

1. لا تحذف ADR قديمًا فقط لأن القرار تغير.
2. غيّر حالته إلى `Superseded` واربطه بالجديد.
3. لا تنشئ ADR لكل تعديل صغير.
4. القرار يجب أن يشرح **لماذا** وليس فقط **ماذا**.
5. اربط القرار بالكود أو PR/commit/issue عندما يكون ذلك مفيدًا.

أنشئ `docs/adr/README.md` يشرح numbering، statuses، ومتى يجب إنشاء ADR.

---

# 11) `PLANS.md` — الأعمال الطويلة ومتعددة المراحل

استخدم `PLANS.md` أو خطة تنفيذ مكافئة عندما تكون المهمة:

- طويلة الأفق.
- متعددة المراحل.
- عالية المخاطر.
- تتضمن migration.
- تتطلب تغييرات موزعة على عدة مكونات.
- قد تستمر عبر أكثر من جلسة/محادثة.

يجب أن تكون الخطة **living document**، لا قائمة أمنيات قديمة.

البنية المقترحة:

```markdown
# EXECUTION PLAN

## Objective

## Success Criteria

## Non-Goals

## Constraints

## Current Baseline

## Risks

## Milestones

### Milestone 1
- Goal:
- Changes:
- Validation:
- Exit criteria:

### Milestone 2
...

## Decisions Needed

## Progress

## Discoveries

## Blockers

## Final Validation

## Completion Criteria
```

عند انتهاء الخطة، لا تجعلها تنافس `PROJECT_STATE.md`. انقل ما أصبح قرارًا دائمًا إلى ADR، وما أصبح حالة حالية إلى `PROJECT_STATE.md`، وما أصبح تغيير إصدار إلى `CHANGELOG.md` عند الحاجة.

---

# 12) Runbooks — إجراءات التشغيل القابلة للتنفيذ

إذا كان المشروع يحتوي Production أو عمليات تشغيل متكررة، أنشئ/حدّث runbooks مناسبة، مثل:

```text
docs/runbooks/deployment.md
docs/runbooks/rollback.md
docs/runbooks/production-verification.md
docs/runbooks/incident-response.md
```

ويمكن إضافة runbooks متخصصة مثل:

```text
email-delivery-failure.md
database-recovery.md
cache-purge.md
credential-rotation.md
worker-failure.md
```

كل runbook مهم يجب أن يوضح قدر الإمكان:

- Scope.
- Preconditions.
- Required access/permissions.
- Safety warnings.
- Exact commands/actions.
- Verification steps.
- Rollback/abort conditions.
- Expected signals.
- Failure modes.
- Escalation path عندما يكون مناسبًا.

لا تضع قيم الأسرار داخل runbook.

---

# 13) Postmortems — للحوادث المهمة فقط

إذا حدث Incident مهم في Production، استخدم `docs/postmortems/` بدل حشو `PROJECT_STATE.md` بالتاريخ الكامل للحادث.

الصيغة المقترحة:

```markdown
# Postmortem: <Incident>

## Summary
## Impact
## Detection
## Timeline
## Trigger
## Root Cause(s)
## Contributing Factors
## Mitigation
## Resolution
## What Went Well
## What Went Poorly
## Where We Got Lucky
## Action Items
## Owners / Tracking
## Prevention / Follow-up
```

يجب أن تكون postmortems **blameless** وتركز على النظام والعمليات والضوابط، لا لوم الأشخاص.

---

# 14) `CHANGELOG.md` والتاريخ

لا تجعل `PROJECT_STATE.md` أو `HISTORY.md` نسخة ثانية من `git log`.

استخدم:

- **Git history** → تفاصيل commits.
- **Tags/Releases** → الإصدارات القابلة للإشارة.
- **CHANGELOG.md** → تغييرات مهمة ومفهومة للإنسان عندما يحتاج المشروع ذلك.
- **ADRs** → القرارات وسببها.
- **Postmortems** → الحوادث والتعلم منها.

إذا كان `HISTORY.md` موجودًا وله قيمة فعلية، لا تحذفه تلقائيًا؛ قيّم دوره، ثم إما:

- أبقه كسجل تاريخي محدود واضح الغرض، أو
- ادمج المعلومات المفيدة في CHANGELOG/ADRs/postmortems، أو
- علّمه legacy إذا كان تغييره قد يسبب ارتباكًا.

---

# 15) إدارة المشاكل والـIssues

لا تحول `PROJECT_STATE.md` إلى issue tracker كامل.

إذا كان المشروع يستخدم GitHub Issues أو نظام تتبع آخر:

- احتفظ بالتفاصيل هناك.
- ضع في `PROJECT_STATE.md` فقط أهم المشاكل النشطة المؤثرة على الاستمرار.
- استخدم references مثل `#123` عندما تكون متاحة.

مثال:

```markdown
## Known Issues / Blockers
- #148 — Email confirmation delivery — HIGH — blocks production acceptance.
- #153 — Map preview failure — MEDIUM — workaround available.
```

إذا لم يوجد issue tracker، يمكن الاحتفاظ بتفاصيل أكثر في الملف، لكن تجنب الازدواجية.

---

# 16) متى يجب تحديث `PROJECT_STATE.md`

لا تحدثه لكل commit صغير.

حدّثه عند **Meaningful State Transition**، ومنها:

- Feature مكتملة أو انتقلت لحالة جديدة.
- Bug مهم تم إصلاحه أو اكتشافه.
- blocker جديد.
- تغيير architecture.
- migration.
- release.
- merge مهم.
- deployment.
- rollback.
- تغيير Production.
- تغيير environment أو runtime أساسي.
- تغيير CI/CD.
- تغير نتائج validation الحاسمة.
- قرار تقني مهم.
- توقف العمل في منتصف مهمة مع وجود uncommitted state مهم.
- قبل انتهاء جلسة طويلة إذا كانت هناك معلومات يصعب إعادة بنائها.

لا تحدثه لمجرد:

- typo.
- formatting فقط.
- comment صغير.
- تعديل لا يغير حالة المشروع أو نقطة الاستئناف.

---

# 17) تحديث الحالة أثناء العمل، لا في النهاية فقط

لا تنتظر نهاية محادثة طويلة لتوثيق كل شيء.

إذا وصلت إلى نقطة آمنة ومهمة من العمل:

1. ثبّت الحالة القابلة للتحقق.
2. حدّث الوثائق المناسبة.
3. سجل blocker/decision/result المهم فورًا.
4. اترك `NEXT ACTION` صالحًا للاستئناف.

الهدف أن يؤدي انقطاع الجلسة المفاجئ إلى فقدان أقل قدر ممكن من السياق.

---

# 18) Working Tree غير النظيف

إذا كانت هناك تغييرات غير committed، لا تخفها.

سجل فقط ما يلزم للاستئناف الآمن، مثل:

```markdown
## Uncommitted Work
Status: DIRTY
Purpose: Work in progress for <task>.
Files:
- `src/...`
- `tests/...`
Safe to discard: NO
Validation performed: partial only
Next step: ...
```

ولا تدّع أن الحالة `CLEAN` دون التحقق.

---

# 19) المصدر الحقيقي لحالة Production

رتب الأدلة حسب طبيعتها:

- Git يثبت حالة الكود/version history.
- GitHub/CI يثبت حالة workflow/checks.
- منصة النشر تثبت deployment metadata.
- health check/smoke test/observability يثبت أن الخدمة تعمل فعليًا.

لا تستخدم commit في Git كدليل وحيد على أن Production يعمل عليه.

إذا كان للمشروع Cloudflare أو AWS أو Vercel أو Kubernetes أو نظام نشر آخر، استخدم أدوات المنصة المتاحة للتحقق من الحالة الفعلية عندما يكون النشر ضمن المهمة.

إذا لم تتوفر الصلاحية أو الأداة، اكتب:

```text
NOT VERIFIED — current environment lacks access to deployment metadata.
```

---

# 20) CI/CD Guardrails

افحص CI/CD الحالي قبل إضافة أي workflow جديد.

إذا كان مناسبًا وآمنًا، اجعل CI يتحقق من بعض الأمور مثل:

- build.
- tests.
- lint/typecheck.
- secret scanning المتاح.
- dependency/security checks المناسبة للمشروع.
- وجود ملفات أساسية ضرورية إن كان غيابها سيكسر العملية فعلًا.
- صحة روابط/تنسيق ADR عند الحاجة.

لكن:

1. لا تضف checks وهمية أو غير قابلة للتشغيل.
2. لا تجعل CI يفشل دائمًا بسبب أداة غير متاحة في الخطة/البيئة.
3. لا تضف required check قبل التأكد أنه يعمل فعلًا.
4. لا تصف حماية branch/ruleset بأنها مفعلة ما لم تتحقق منها عبر GitHub API/UI أو تكامل موثوق.
5. إذا كانت إعدادات GitHub خارج ملفات المستودع غير قابلة للقراءة بسبب الصلاحيات، سجّل ذلك صراحة كـ `NOT VERIFIED`.

إذا كانت الصلاحيات تسمح، راجع Rulesets/Branch Protection بما يلائم المشروع، مثل:

- required status checks.
- review requirements عند الحاجة.
- restrictions على الفروع الحساسة.
- deployment environment protections.

لا تغيّر إعدادات repository خارج المستودع بلا صلاحية أو بلا حاجة مؤكدة.

---

# 21) الأسرار والمعلومات الحساسة

ممنوع تسجيل قيم:

- API tokens.
- passwords.
- private keys.
- SSH private keys.
- cookies.
- session tokens.
- database passwords.
- OAuth client secrets.
- signing secrets.
- production credentials.

يمكن تسجيل **أسماء المتغيرات فقط**:

```text
CLOUDFLARE_API_TOKEN
GITHUB_TOKEN
DATABASE_URL
EMAIL_API_KEY
```

ويجب أن يكون واضحًا أين تتم إدارتها: GitHub Secrets، Cloudflare Secrets، secret manager، environment configuration، إلخ، دون كشف القيمة.

---

# 22) التسلسل الهرمي لمصادر الحقيقة

عند التعارض، استخدم هذا الترتيب:

1. **Verified actual runtime/deployment state** للحقائق التشغيلية.
2. **Git repository actual state** للكود والـcommit/branch/working tree.
3. **CI/CD actual results** للبناء والاختبارات والنشر المسجل.
4. **`PROJECT_STATE.md` بعد تحديثه بالواقع المتحقق منه** كملخص الاستئناف الحالي.
5. **`AGENTS.md`** للقواعد الدائمة.
6. **Accepted ADRs** للقرارات المعمارية المعتمدة.
7. **Relevant runbooks** لإجراءات التشغيل.
8. **`PLANS.md`** للخطة الحالية، ما لم يثبت الواقع أنها قديمة.
9. **CHANGELOG / release notes / historical docs** للسجل.
10. **Conversation memory / previous chat summaries** كمرجع مساعد فقط.

إذا تعارضت الذاكرة مع واقع متحقق منه، تجاهل الذاكرة وحدّث الوثائق.

---

# 23) لا تكرر الحقيقة في أكثر من مكان

أمثلة:

- لا تنسخ ADR كاملًا داخل `PROJECT_STATE.md`؛ اربط به.
- لا تنسخ runbook كاملًا داخل `AGENTS.md`؛ اذكر متى يجب قراءته.
- لا تنسخ git log داخل `CHANGELOG.md`.
- لا تنسخ قائمة issues كاملة داخل `PROJECT_STATE.md`.

استخدم references واضحة لتقليل التضخم والتناقض.

---

# 24) التنظيف وإزالة المعلومات القديمة

في التهيئة الأولى:

راجع المستندات الحالية وابحث عن:

- SHA قديم يوصف بأنه الحالي.
- إصدار قديم يوصف بأنه active.
- مسار لم يعد موجودًا.
- خدمة أزيلت.
- منفذ تغير.
- issue تم حلها وما زالت موصوفة كـ blocker.
- تعليمات deployment قديمة.
- أوامر build/test لم تعد تعمل.
- ملفات تعليمات AI متعارضة.
- حالات Production غير موثقة أو متناقضة.

صحح أو أزل المعلومات القديمة **فقط بعد التحقق**.

لا تحذف تاريخًا مهمًا؛ انقله إلى المكان الصحيح عند الحاجة.

---

# 25) التنفيذ الأول — لا تنشئ Templates فارغة

نفّذ تهيئة حقيقية للحالة الحالية الآن.

## المرحلة A — Discovery

افحص على الأقل ما ينطبق على المشروع:

```bash
git status --short --branch
git branch --show-current
git rev-parse HEAD
git log -1 --oneline
git remote -v
git tag --sort=-creatordate
```

ثم افحص:

- structure.
- package manifests / lockfiles.
- runtime/toolchain versions.
- build scripts.
- test scripts.
- CI workflows.
- deployment configuration.
- environment configuration names فقط دون كشف secrets.
- documentation.
- active services/configs إن كانت متاحة.
- release/version metadata.
- production deployment metadata إذا كانت الصلاحيات متاحة وكان ذلك ضمن نطاق آمن.

## المرحلة B — Reconciliation

قارن بين:

- المستندات الحالية.
- Git الفعلي.
- CI الفعلي.
- deployment الفعلي.
- runtime الفعلي.

حدد أي Drift أو تعارض.

## المرحلة C — Build the documentation system

أنشئ/حدّث فقط ما يلزم من:

- `AGENTS.md`
- `PROJECT_STATE.md`
- `PLANS.md`
- `CHANGELOG.md`
- `docs/architecture/`
- `docs/adr/`
- `docs/runbooks/`
- `docs/postmortems/`

استخدم المحتوى الفعلي، لا placeholders، باستثناء الحقول التي لا يمكن التحقق منها ويجب وسمها بوضوح `NOT VERIFIED`.

## المرحلة D — Validation

شغّل فقط الاختبارات المناسبة والآمنة المتاحة في البيئة الحالية.

سجّل:

- الأوامر.
- النتائج الفعلية.
- failures.
- skipped checks.
- limitations.

## المرحلة E — Final state reconciliation

بعد أي تغييرات وcommits:

- أعد فحص branch/HEAD/working tree.
- تأكد أن `PROJECT_STATE.md` لا يحتوي ادعاءات stale ناتجة عن التحديث نفسه.
- تأكد أن `NEXT ACTION` قابل للتنفيذ مباشرة.
- تأكد أن أي `PASS` أو `DEPLOYED` له دليل.

---

# 26) حدود النطاق

هذا الطلب يهدف إلى بناء نظام الاستمرارية والتسليم.

لا تغيّر business logic أو production behavior لمجرد أنك اكتشفت مشكلة جانبية، إلا إذا:

- كان التغيير ضروريًا لإكمال نظام التوثيق بأمان، أو
- كان ضمن طلب المستخدم الحالي أصلًا.

إذا اكتشفت مشكلة خارج النطاق:

1. وثقها في المكان المناسب.
2. أنشئ issue إن كانت الأدوات والسياسة تسمح وكان ذلك مفيدًا.
3. لا توسع المهمة بلا داعٍ.

---

# 27) سياسة Git والـCommit لهذا الطلب

إذا كانت قواعد المشروع تسمح بإنشاء commit:

1. طبّق التغييرات.
2. شغّل validation المناسب.
3. راجع diff.
4. تأكد من عدم وجود secrets.
5. أنشئ commit واضحًا، مثال:

```text
docs: establish canonical project continuity and handoff system
```

6. أعد التحقق من Git بعد الـcommit.
7. لا تدخل في حلقة لا نهائية لتحديث SHA داخل الملف؛ استخدم مفهوم **verified implementation baseline** كما هو موضح أعلاه.

لا تعمل push أو deploy إلا إذا كان ذلك مسموحًا ضمن تعليمات المشروع/طلب المستخدم الحالي.

---

# 28) تعريف Done لهذا النظام

لا تعتبر هذه المهمة مكتملة حتى تتحقق الشروط المناسبة التالية:

- [ ] تم فحص المستودع الحالي فعليًا.
- [ ] تم اكتشاف الوثائق والتعليمات القائمة قبل إنشاء ملفات جديدة.
- [ ] لا توجد مصادر حقيقة متنافسة دون تفسير.
- [ ] `AGENTS.md` موجود ومناسب أو تم توثيق سبب عدم استخدامه.
- [ ] `PROJECT_STATE.md` يعكس الحالة الحالية المتحقق منها.
- [ ] `PROJECT_STATE.md` لا يعتمد على SHA ذاتي يصبح stale فور commit.
- [ ] Desired State منفصل عن Actual State عند وجود نشر.
- [ ] Git وCI وProduction غير مخلوطة في مفهوم واحد.
- [ ] Working Tree موصوف بدقة.
- [ ] نتائج validation موثقة بأوامر ونتائج فعلية.
- [ ] حالات `NOT VERIFIED` ظاهرة ولا يتم إخفاؤها.
- [ ] القرارات المهمة موجودة كـ ADRs عند الحاجة.
- [ ] الأعمال الطويلة لها خطة living document عند الحاجة.
- [ ] runbooks موجودة للعمليات الحرجة المتكررة عند الحاجة.
- [ ] postmortems مفصولة عن الحالة الحالية عند الحاجة.
- [ ] الأسرار غير موجودة في ملفات التوثيق.
- [ ] تم إزالة/تصحيح المعلومات الحالية القديمة المتعارضة.
- [ ] `NEXT ACTION` دقيق وقابل للتنفيذ.
- [ ] محادثة جديدة يمكنها استئناف العمل دون الوصول إلى المحادثة الحالية.

---

# 29) صياغة `NEXT ACTION` المطلوبة

يجب ألا يكون غامضًا مثل:

```text
Continue development.
Fix remaining issues.
```

بل يكون مثل:

```markdown
## NEXT ACTION

1. Reproduce the remaining email confirmation failure in `src/services/email/...`.
2. Verify the active provider configuration without exposing secrets.
3. Add/adjust the smallest safe fix.
4. Run:
   - `npm test`
   - `npm run build`
5. Verify the contact and technical-report flows.
6. If deployment is requested and permitted, deploy using `docs/runbooks/deployment.md`.
7. Verify Production using `docs/runbooks/production-verification.md`.
8. Update this state document with actual results and any remaining blocker.
```

يجب أن يستطيع وكيل جديد تنفيذها دون تخمين جوهري.

---

# 30) تعليمات الاستئناف التي يجب إضافتها إلى `PROJECT_STATE.md`

استخدم صياغة قريبة من:

```text
Resume protocol for a new ChatGPT/Codex session:

1. Read AGENTS.md first.
2. Read PROJECT_STATE.md second.
3. Inspect Git branch, HEAD, and working tree; do not assume the file is current.
4. If verified reality differs from PROJECT_STATE.md, reconcile the document before relying on it.
5. Read only the ADRs relevant to the task.
6. Read the relevant runbook before deployment, rollback, or incident actions.
7. Read PLANS.md when a multi-stage plan is active.
8. Treat old conversation memory as non-authoritative.
9. Do not repeat completed work unless verification shows it is incomplete or regressed.
10. Continue from NEXT ACTION unless the user explicitly changes the goal.
```

---

# 31) قاعدة الاستمرارية الدائمة

أضف إلى `AGENTS.md` قاعدة دائمة بهذا المعنى:

> **After every meaningful state transition, reconcile the canonical project handoff with the verified current state. Record what changed, what was actually validated, any active blocker or drift, and the precise next action. Do not duplicate Git/CI/issue-tracker history, do not record secrets, and do not claim success without evidence. Keep the handoff small enough that a completely new agent session can resume quickly and correctly.**

وأضف أيضًا:

> **Conversation memory is advisory context, not authoritative project state. When memory, documentation, Git, CI, or runtime disagree, verify reality and reconcile the documentation.**

---

# 32) سلوك الوكيل أثناء التنفيذ

أثناء تنفيذ هذا الطلب:

- لا تكتفِ باقتراحات نظرية.
- لا تنشئ ملفات فارغة وتعلن النجاح.
- لا تدّع الوصول إلى GitHub/Production إذا لم يكن متاحًا.
- لا تعيد كتابة المشروع دون حاجة.
- لا تخترع نتائج اختبار.
- لا تخترع SHA.
- لا تخترع release/version.
- لا تخترع deployment metadata.
- لا تخترع branches/rulesets.
- لا تستخدم الذاكرة القديمة لتجاوز التحقق المباشر.
- لا تمس الأسرار.
- لا توقف المهمة بسبب نقص معلومة غير ضرورية؛ استخدم أفضل تحقق متاح ووسم ما تعذر التحقق منه بوضوح.

عند وجود أداة قادرة على التحقق المباشر، استخدمها بدل التخمين.

---

# 33) المخرجات النهائية المطلوبة من الوكيل

بعد التنفيذ، أعطني ملخصًا تنفيذيًا يتضمن فقط الحقائق الفعلية:

1. الملفات التي أنشئت/عُدلت.
2. ما الذي أصبح المصدر الرسمي لكل نوع من المعلومات.
3. branch والـverified baseline الحاليين.
4. Working Tree النهائي.
5. validation الذي تم تشغيله فعلًا ونتيجته.
6. ما تم التحقق منه من CI/Production وما تعذر التحقق منه.
7. أي drift تم اكتشافه.
8. ADRs أو runbooks التي أضيفت ولماذا.
9. commit الذي تم إنشاؤه إن وجد.
10. `NEXT ACTION`.

لا تستخدم كلمة `complete` أو `production verified` إلا إذا كانت شروطها متحققة فعليًا.

---

# 34) رسالة بدء أي محادثة جديدة بعد تطبيق النظام

بعد اكتمال هذا النظام، يجب أن تكون الرسالة التالية كافية لبدء محادثة جديدة:

```text
اقرأ AGENTS.md وPROJECT_STATE.md أولًا.
تحقق بنفسك من Git branch وHEAD وWorking Tree قبل الاعتماد على الحالة المسجلة.
إذا وجدت اختلافًا بين الواقع وPROJECT_STATE.md فحدّث الحالة أولًا.
اقرأ ADRs وrunbooks وPLANS.md ذات الصلة فقط عند الحاجة.
اعتبر ذاكرة المحادثات السابقة سياقًا مساعدًا وليست مصدر الحقيقة.
لا تعيد العمل المنجز ما لم يثبت أنه ناقص أو تراجع.
ثم استكمل مباشرة من NEXT ACTION ما لم أغيّر الأولوية في طلبي الحالي.
```

---

# 35) المراجع الهندسية التي بُني عليها هذا النظام

تم تصميم هذه السياسة لتتوافق مع ممارسات موثقة من مصادر رسمية، منها:

- OpenAI Codex — `AGENTS.md` لتعليمات المستودع الدائمة:
  https://developers.openai.com/codex/agent-configuration/agents-md
- OpenAI Codex — Customization overview:
  https://developers.openai.com/codex/customization/overview
- OpenAI Codex — Best practices:
  https://developers.openai.com/codex/learn/best-practices
- OpenAI — Using `PLANS.md` for long-horizon problem solving:
  https://developers.openai.com/cookbook/articles/codex_exec_plans
- AWS Prescriptive Guidance — Architecture Decision Records:
  https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html
- AWS — ADR best practices:
  https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/best-practices.html
- GitHub — Rulesets and required status checks:
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
- GitHub — Deployments and environments:
  https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- Google SRE — On-call playbooks/runbooks:
  https://sre.google/workbook/on-call/
- Google SRE — Incident management:
  https://sre.google/resources/practices-and-processes/incident-management-guide/
- Google SRE — Postmortem culture:
  https://sre.google/sre-book/postmortem-culture/
- OpenGitOps — Declarative, versioned, automatically reconciled desired state principles:
  https://opengitops.dev/

---

# 36) الأمر النهائي

**نفّذ هذا النظام الآن داخل المشروع وفق الواقع الفعلي للمستودع والأدوات والصلاحيات المتاحة. لا تكتفِ بشرحه. لا تنشئ توثيقًا شكليًا. لا تعتمد على ذاكرة المحادثات كحقيقة. لا تسجل نجاحًا غير متحقق منه. اجعل النتيجة قابلة للاستمرار من محادثة جديدة تمامًا، مع أقل قدر ممكن من إعادة الاكتشاف، وبدون خلق مصدر حقيقة ثانٍ ينافس Git/CI/Production.**
