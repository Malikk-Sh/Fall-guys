from pathlib import Path

p = Path('server/adminControl.js')
text = p.read_text()
old = """    if (!result.ok) {
      return result.case ? { ...result, case: this.#decorateCase(result.case) } : result;
    }
    return { ...result, case: this.#decorateCase(result.case) };
"""
new = """    if (!result.ok) {
      return result.case
        ? {
            ...result,
            case: {
              ...this.#decorateCase(result.case),
              sanctions: this.#sanctionContext(targetAccountId, now)
            }
          }
        : result;
    }
    return {
      ...result,
      case: {
        ...this.#decorateCase(result.case),
        sanctions: this.#sanctionContext(targetAccountId, now)
      }
    };
"""
if old not in text:
    raise SystemExit('adminControl moderation transition anchor missing')
p.write_text(text.replace(old, new, 1))
