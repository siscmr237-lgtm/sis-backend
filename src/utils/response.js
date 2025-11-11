function withIdAsCode(record) {
  if (!record) return record;
  const { code, id, ...rest } = record;
  return { id: code ?? id, ...rest };
}

function mapWithIdAsCode(records) {
  return (records || []).map(withIdAsCode);
}

module.exports = { withIdAsCode, mapWithIdAsCode };
