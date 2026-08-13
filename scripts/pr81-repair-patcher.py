from pathlib import Path

path = Path('scripts/pr81-integrate-alert-center.py')
text = path.read_text()

auth_old_block = '''auth = Path('server/adminAuth.js')
replace_once(
    auth,
    """    'reliability.read',
    'analytics.read',
""",
    """    'reliability.read',
    'alerts.read',
    'alerts.ack',
    'analytics.read',
""",
)
# Same sequence appears once more in operator capabilities.
replace_once(
    auth,
    """    'reliability.read',
    'analytics.read',
""",
    """    'reliability.read',
    'alerts.read',
    'alerts.ack',
    'analytics.read',
""",
)
'''
auth_new_block = '''auth = Path('server/adminAuth.js')
auth_text = auth.read_text()
auth_old = """    'reliability.read',
    'analytics.read',
"""
auth_new = """    'reliability.read',
    'alerts.read',
    'alerts.ack',
    'analytics.read',
"""
if auth_text.count(auth_old) != 2:
    raise SystemExit(f"{auth}: expected exactly two owner/operator capability anchors")
auth.write_text(auth_text.replace(auth_old, auth_new, 2))
'''
if text.count(auth_old_block) != 1:
    raise SystemExit('could not find the original adminAuth patch block exactly once')
text = text.replace(auth_old_block, auth_new_block, 1)

audit_old = """    assert.deepEqual(audit, { action: 'alert.acknowledged', target_id: alertId });
"""
audit_new = """    assert.equal(audit.action, 'alert.acknowledged');
    assert.equal(audit.target_id, alertId);
"""
if text.count(audit_old) != 1:
    raise SystemExit('could not find the SQLite audit assertion exactly once')
text = text.replace(audit_old, audit_new, 1)

path.write_text(text)
