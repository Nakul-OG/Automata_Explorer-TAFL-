"""
Automata Explorer — Backend
Endpoints: /health  /gen  /eq  /dfa
Run: pip install flask flask-cors && python backend.py
"""
from flask import Flask, request, jsonify
from flask_cors import CORS
from collections import deque

app = Flask(__name__)
CORS(app)

# ─────────────────────────────────────────────
#  TOKENIZER + PARSER  (no regex library)
# ─────────────────────────────────────────────
ALPHABET = list('abcdefghijklmnopqrstuvwxyz0123456789')

class ParseError(Exception): pass

def tokenize(s):
    tokens, i = [], 0
    while i < len(s):
        c = s[i]
        if c == 'ε': tokens.append(('EPS',)); i += 1
        elif c == '(': tokens.append(('LPAREN',)); i += 1
        elif c == ')': tokens.append(('RPAREN',)); i += 1
        elif c == '+': tokens.append(('UNION',)); i += 1   # + is now union/OR
        elif c == '*': tokens.append(('STAR',)); i += 1
        elif c == '|': tokens.append(('PLUS',)); i += 1   # | is now Kleene plus
        elif c == '?': tokens.append(('OPT',)); i += 1
        elif c == '.': tokens.append(('DOT',)); i += 1
        elif c == '[':
            j = i + 1; negate = False
            if j < len(s) and s[j] == '^': negate = True; j += 1
            chars = set()
            while j < len(s) and s[j] != ']':
                if j + 2 < len(s) and s[j+1] == '-' and s[j+2] != ']':
                    for ch in range(ord(s[j]), ord(s[j+2])+1): chars.add(chr(ch))
                    j += 3
                else: chars.add(s[j]); j += 1
            if negate:
                chars = set(ALPHABET) - chars
            tokens.append(('CLASS', frozenset(c for c in chars if c in ALPHABET)))
            i = j + 1
        elif c in ALPHABET: tokens.append(('SYM', c)); i += 1
        else: i += 1
    return tokens

class Parser:
    def __init__(self, tokens):
        self.tokens = tokens; self.pos = 0
    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else ('EOF',)
    def consume(self, t=None):
        tok = self.tokens[self.pos]; self.pos += 1
        if t and tok[0] != t: raise ParseError(f'Expected {t}, got {tok[0]}')
        return tok
    def parse(self):
        node = self.expr()
        if self.peek()[0] != 'EOF': raise ParseError('Unexpected token')
        return node
    def expr(self):
        left = self.concat()
        while self.peek()[0] == 'UNION':
            self.consume('UNION'); right = self.concat()
            left = ('UNION', left, right)
        return left
    def concat(self):
        nodes = []
        while self.peek()[0] not in ('RPAREN','UNION','EOF'):
            nodes.append(self.repeat())
        if not nodes: return ('EPS',)
        result = nodes[0]
        for n in nodes[1:]: result = ('CONCAT', result, n)
        return result
    def repeat(self):
        node = self.atom()
        while self.peek()[0] in ('STAR','PLUS','OPT'):
            op = self.consume()[0]
            if op == 'STAR': node = ('STAR', node)
            elif op == 'PLUS': node = ('PLUS', node)
            else: node = ('OPT', node)
        return node
    def atom(self):
        t = self.peek()
        if t[0] == 'LPAREN':
            self.consume('LPAREN'); node = self.expr(); self.consume('RPAREN'); return node
        if t[0] == 'SYM': self.consume(); return ('SYM', t[1])
        if t[0] == 'CLASS': self.consume(); return ('CLASS', t[1])
        if t[0] == 'DOT': self.consume(); return ('DOT',)
        if t[0] == 'EPS': self.consume(); return ('EPS',)
        raise ParseError(f'Unexpected token: {t[0]}')

def parse(s):
    if not s.strip(): return ('EPS',)
    toks = tokenize(s)
    if not toks: return ('EPS',)
    p = Parser(toks + [('EOF',)])
    return p.parse()

# ─────────────────────────────────────────────
#  STRING GENERATOR  (BFS over AST)
# ─────────────────────────────────────────────
def gen_strings(node, maxlen):
    results = set()
    queue = deque()
    queue.append((node, '', maxlen))
    while queue:
        n, prefix, budget = queue.popleft()
        if n[0] == 'EPS':
            if len(prefix) <= maxlen: results.add(prefix)
        elif n[0] == 'SYM':
            s2 = prefix + n[1]
            if len(s2) <= maxlen: results.add(s2)
        elif n[0] == 'DOT':
            for c in ALPHABET:
                s2 = prefix + c
                if len(s2) <= maxlen: results.add(s2)
        elif n[0] == 'CLASS':
            for c in sorted(n[1]):
                s2 = prefix + c
                if len(s2) <= maxlen: results.add(s2)
        elif n[0] == 'UNION':
            queue.append((n[1], prefix, budget)); queue.append((n[2], prefix, budget))
        elif n[0] == 'CONCAT':
            queue.append((n[1], prefix, budget - len(prefix)))
            # will be expanded by continuation; handle via two-phase BFS
            for left_str in gen_strings(n[1], maxlen - len(prefix)):
                if len(prefix + left_str) <= maxlen:
                    queue.append((n[2], prefix + left_str, maxlen))
            continue
        elif n[0] in ('STAR', 'PLUS'):
            inner = n[1]; base = gen_strings(inner, maxlen - len(prefix))
            if n[0] == 'STAR' and len(prefix) <= maxlen: results.add(prefix)
            cur = {''} if n[0] == 'STAR' else set(b for b in base if b)
            for s in cur:
                if len(prefix+s) <= maxlen: results.add(prefix+s)
            for rep in range(1, maxlen+1):
                next_set = set()
                for s in cur:
                    for b in base:
                        ns = s + b
                        if len(ns) <= maxlen - len(prefix): next_set.add(ns)
                if not next_set: break
                for s in next_set:
                    if len(prefix+s) <= maxlen: results.add(prefix+s)
                cur = next_set
        elif n[0] == 'OPT':
            results.add(prefix); queue.append((n[1], prefix, budget))
    return results

def safe_gen(re_str, maxlen):
    node = parse(re_str)
    return sorted(gen_strings(node, maxlen), key=lambda x: (len(x), x))

# ─────────────────────────────────────────────
#  NFA  (Thompson's Construction)
# ─────────────────────────────────────────────
class NFA:
    def __init__(self):
        self.states = 0; self.start = 0; self.accept = 0
        self.trans = {}  # {state: {sym: [states]}}
    def new_state(self):
        s = self.states; self.states += 1; return s
    def add(self, frm, sym, to):
        self.trans.setdefault(frm, {}).setdefault(sym, [])
        self.trans[frm][sym].append(to)
    def epsilon_closure(self, states):
        closure = set(states); stack = list(states)
        while stack:
            s = stack.pop()
            for t in self.trans.get(s, {}).get('ε', []):
                if t not in closure: closure.add(t); stack.append(t)
        return frozenset(closure)
    def move(self, states, sym):
        result = set()
        for s in states:
            for t in self.trans.get(s, {}).get(sym, []): result.add(t)
        return result

def build_nfa(node):
    nfa = NFA()
    s, e = _build(nfa, node)
    nfa.start = s; nfa.accept = e
    return nfa

def _build(nfa, node):
    t = node[0]
    if t == 'EPS':
        s = nfa.new_state(); e = nfa.new_state(); nfa.add(s,'ε',e); return s,e
    elif t == 'SYM':
        s = nfa.new_state(); e = nfa.new_state(); nfa.add(s,node[1],e); return s,e
    elif t == 'DOT':
        s = nfa.new_state(); e = nfa.new_state()
        for c in ALPHABET: nfa.add(s,c,e)
        return s,e
    elif t == 'CLASS':
        s = nfa.new_state(); e = nfa.new_state()
        for c in node[1]: nfa.add(s,c,e)
        return s,e
    elif t == 'UNION':
        s = nfa.new_state(); e = nfa.new_state()
        s1,e1 = _build(nfa,node[1]); s2,e2 = _build(nfa,node[2])
        nfa.add(s,'ε',s1); nfa.add(s,'ε',s2); nfa.add(e1,'ε',e); nfa.add(e2,'ε',e)
        return s,e
    elif t == 'CONCAT':
        s1,e1 = _build(nfa,node[1]); s2,e2 = _build(nfa,node[2])
        nfa.add(e1,'ε',s2); return s1,e2
    elif t == 'STAR':
        s = nfa.new_state(); e = nfa.new_state()
        si,ei = _build(nfa,node[1])
        nfa.add(s,'ε',si); nfa.add(s,'ε',e); nfa.add(ei,'ε',si); nfa.add(ei,'ε',e)
        return s,e
    elif t == 'PLUS':
        s = nfa.new_state(); e = nfa.new_state()
        si,ei = _build(nfa,node[1])
        nfa.add(s,'ε',si); nfa.add(ei,'ε',si); nfa.add(ei,'ε',e)
        return s,e
    elif t == 'OPT':
        s = nfa.new_state(); e = nfa.new_state()
        si,ei = _build(nfa,node[1])
        nfa.add(s,'ε',si); nfa.add(s,'ε',e); nfa.add(ei,'ε',e)
        return s,e
    else:
        s = nfa.new_state(); e = nfa.new_state(); nfa.add(s,'ε',e); return s,e

# ─────────────────────────────────────────────
#  NFA → DFA  (Subset Construction)
# ─────────────────────────────────────────────
def nfa_to_dfa(nfa, re_str):
    # Determine alphabet from RE
    alpha = sorted(set(c for c in re_str if c in ALPHABET)) or ['a','b']
    start_closure = nfa.epsilon_closure({nfa.start})
    state_map = {start_closure: 'q0'}
    queue = deque([start_closure])
    dfa_trans = {}
    dfa_accept = []
    idx = [1]

    while queue:
        cur = queue.popleft()
        label = state_map[cur]
        dfa_trans[label] = {}
        for sym in alpha:
            moved = nfa.move(cur, sym)
            closure = nfa.epsilon_closure(moved)
            if not closure:
                dfa_trans[label][sym] = 'qdead'
            else:
                if closure not in state_map:
                    new_label = 'q'+str(idx[0]); idx[0]+=1
                    state_map[closure] = new_label
                    queue.append(closure)
                dfa_trans[label][sym] = state_map[closure]
        if nfa.accept in cur: dfa_accept.append(label)

    # Add dead state transitions
    dfa_trans['qdead'] = {sym:'qdead' for sym in alpha}
    all_states = list(dict.fromkeys(list(state_map.values()) + ['qdead']))

    # Minimise: remove unreachable states
    reachable = set(); visited = {'q0'}; stack = ['q0']
    while stack:
        s = stack.pop(); reachable.add(s)
        for sym in alpha:
            t = dfa_trans.get(s,{}).get(sym,'qdead')
            if t not in visited: visited.add(t); stack.append(t)
    states = [s for s in all_states if s in reachable]

    return {
        'states': states,
        'alphabet': alpha,
        'start': 'q0',
        'accept': dfa_accept,
        'transitions': {s: dfa_trans.get(s,{}) for s in states},
        're': re_str
    }

# ─────────────────────────────────────────────
#  ROUTES
# ─────────────────────────────────────────────
@app.route('/health')
def health():
    return jsonify({'ok': True, 'version': '2.0-dfa'})

@app.route('/gen', methods=['POST'])
def gen():
    data = request.get_json(force=True)
    re_str = data.get('re','').strip()
    mx = max(0, min(12, int(data.get('mx', 6))))
    if not re_str:
        return jsonify({'error': 'Empty expression'}), 400
    try:
        strings = safe_gen(re_str, mx)
        truncated = len(strings) > 250
        return jsonify({'strings': strings[:250], 'count': len(strings), 'truncated': truncated})
    except ParseError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': 'Internal error: '+str(e)}), 500

@app.route('/eq', methods=['POST'])
def eq():
    data = request.get_json(force=True)
    re1 = data.get('re1','').strip(); re2 = data.get('re2','').strip()
    mx = max(0, min(10, int(data.get('mx', 6))))
    if not re1 or not re2:
        return jsonify({'error': 'Both expressions required'}), 400
    try:
        s1 = set(safe_gen(re1, mx)); s2 = set(safe_gen(re2, mx))
        o1 = sorted(s1-s2, key=lambda x:(len(x),x))[:20]
        o2 = sorted(s2-s1, key=lambda x:(len(x),x))[:20]
        return jsonify({'equivalent': s1==s2, 'c1':len(s1), 'c2':len(s2),
                        'only1':o1, 'only2':o2})
    except ParseError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/dfa', methods=['POST'])
def dfa():
    data = request.get_json(force=True)
    re_str = data.get('re','').strip()
    if not re_str:
        return jsonify({'error': 'Empty expression'}), 400
    try:
        node = parse(re_str)
        nfa = build_nfa(node)
        result = nfa_to_dfa(nfa, re_str)
        return jsonify(result)
    except ParseError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': 'DFA build error: '+str(e)}), 500

if __name__ == '__main__':
    print("╔══════════════════════════════════════╗")
    print("║   Automata Explorer Backend v2.0     ║")
    print("║   http://localhost:5000              ║")
    print("║   DFA endpoint: POST /dfa            ║")
    print("╚══════════════════════════════════════╝")
    app.run(debug=True, host='0.0.0.0', port=5000)
