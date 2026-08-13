from pathlib import Path

path = Path('server/telegramAlertDelivery.test.mjs')
text = path.read_text()
old = """    let record = loadState(ctx.file).records[0];
    assert.equal(record.sentSeverity, null);
    assert.equal(record.resolvedSent, false);

    await deliveryPass({
"""
new = """    // Below-threshold active incidents need no durable delivery record at all.
    assert.equal(loadState(ctx.file).records.length, 0);

    await deliveryPass({
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one below-threshold pre-resolution assertion, found {text.count(old)}')
text = text.replace(old, new, 1)
old = """    record = loadState(ctx.file).records[0];
    assert.equal(record.resolvedSent, true);
"""
new = """    const record = loadState(ctx.file).records[0];
    assert.equal(record.resolvedSent, true);
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one below-threshold resolved assertion, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
