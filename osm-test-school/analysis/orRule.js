// AUTO-EXTRACTED verbatim from teachers-classmap/index.tsx computeOrLoserQNums (types stripped). Do not edit by hand.
function computeOrLoserQNums(questionWiseReport, assessmentQuestions) {
  const loserSet = /* @__PURE__ */ new Set();
  if (!questionWiseReport || questionWiseReport.length === 0) return loserSet;
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const getSide = (n) => {
    const m = n.match(/^(\d+)([a-z])?/);
    return m ? m[1] + (m[2] || "") : n;
  };
  const ciMap = {};
  if (assessmentQuestions) {
    assessmentQuestions.forEach((q) => {
      if (q.questionNumber) ciMap[norm(q.questionNumber)] = q.checkingInstructions || "";
    });
  }
  const getCi = (qr) => ciMap[norm(qr.questionNumber)] || qr.checkingInstructions || "";
  const pairGroups = {};
  questionWiseReport.forEach((qr) => {
    const ci = getCi(qr).toLowerCase();
    if (!ci.includes("alternative question (or)")) return;
    const rawCi = getCi(qr);
    const partnerMatch = rawCi.match(/with\s+question\s+([\w.\-\s()]+?)(?:\.\s|\.$|,|;|$)/i);
    const partnerNorm = partnerMatch ? norm(partnerMatch[1].trim()) : null;
    const selfNorm = norm(qr.questionNumber);
    const stripOr = (n) => n.replace(/^(\d+)or([a-z]*)$/, "$1$2").replace(/^(\d+)([a-z]+)or$/, "$1$2");
    const selfSide = stripOr(selfNorm) !== selfNorm ? selfNorm : getSide(selfNorm);
    const selfKey = getSide(stripOr(selfNorm));
    const partnerKey = partnerNorm ? getSide(stripOr(partnerNorm)) : null;
    const pairKey = partnerKey ? [selfKey, partnerKey].sort().join("|") : selfKey + "|solo";
    if (!pairGroups[pairKey]) pairGroups[pairKey] = [];
    if (!pairGroups[pairKey].some((e) => e.qr.questionNumber === qr.questionNumber)) {
      pairGroups[pairKey].push({ qr, selfSide });
    }
  });
  Object.values(pairGroups).forEach((entries) => {
    const sideMarks = {};
    entries.forEach((e) => {
      sideMarks[e.selfSide] = (sideMarks[e.selfSide] || 0) + (e.qr.marksAwarded || 0);
    });
    const sides = Object.keys(sideMarks);
    if (sides.length < 2) return;
    const sorted = Object.entries(sideMarks).sort((a, b) => b[1] - a[1]);
    const winnerMarks = sorted[0][1];
    const loserMarks = sorted[sorted.length - 1][1];
    if (winnerMarks <= loserMarks) return;
    const loserSides = new Set(sorted.slice(1).map((s) => s[0]));
    entries.forEach((e) => {
      if (loserSides.has(e.selfSide)) loserSet.add(e.qr.questionNumber);
    });
  });
  return loserSet;
}

module.exports={computeOrLoserQNums};
