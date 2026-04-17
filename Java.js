// backend.js
// Automata Explorer — JavaScript Backend (Node.js + Express)
// Provides: /health, /gen, /eq, /dfa
// Run: npm install express cors && node backend.js

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
//  ALPHABET & UTILITIES
// ─────────────────────────────────────────────
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

class ParseError extends Error {
    constructor(msg) { super(msg); this.name = 'ParseError'; }
}

// ─────────────────────────────────────────────
//  TOKENIZER + PARSER  (no regex library)
// ─────────────────────────────────────────────
function tokenize(s) {
    const tokens = [];
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === 'ε') { tokens.push(['EPS']); i++; }
        else if (c === '(') { tokens.push(['LPAREN']); i++; }
        else if (c === ')') { tokens.push(['RPAREN']); i++; }
        else if (c === '+') { tokens.push(['UNION']); i++; }
        else if (c === '*') { tokens.push(['STAR']); i++; }
        else if (c === '|') { tokens.push(['PLUS']); i++; }
        else if (c === '?') { tokens.push(['OPT']); i++; }
        else if (c === '.') { tokens.push(['DOT']); i++; }
        else if (c === '[') {
            let j = i + 1;
            let negate = false;
            if (j < s.length && s[j] === '^') { negate = true; j++; }
            const chars = new Set();
            while (j < s.length && s[j] !== ']') {
                if (j + 2 < s.length && s[j+1] === '-' && s[j+2] !== ']') {
                    const start = s.charCodeAt(j);
                    const end = s.charCodeAt(j+2);
                    for (let code = start; code <= end; code++) {
                        const ch = String.fromCharCode(code);
                        if (ALPHABET.includes(ch)) chars.add(ch);
                    }
                    j += 3;
                } else {
                    if (ALPHABET.includes(s[j])) chars.add(s[j]);
                    j++;
                }
            }
            if (negate) {
                const allSet = new Set(ALPHABET);
                for (const ch of chars) allSet.delete(ch);
                tokens.push(['CLASS', allSet]);
            } else {
                tokens.push(['CLASS', chars]);
            }
            i = j + 1;
        }
        else if (ALPHABET.includes(c)) { tokens.push(['SYM', c]); i++; }
        else { i++; }
    }
    return tokens;
}

class Parser {
    constructor(tokens) {
        this.tokens = tokens;
        this.pos = 0;
    }
    peek() {
        return this.pos < this.tokens.length ? this.tokens[this.pos] : ['EOF'];
    }
    consume(t) {
        const tok = this.tokens[this.pos];
        this.pos++;
        if (t && tok[0] !== t) throw new ParseError(`Expected ${t}, got ${tok[0]}`);
        return tok;
    }
    parse() {
        const node = this.expr();
        if (this.peek()[0] !== 'EOF') throw new ParseError('Unexpected token');
        return node;
    }
    expr() {
        let left = this.concat();
        while (this.peek()[0] === 'UNION') {
            this.consume('UNION');
            const right = this.concat();
            left = ['UNION', left, right];
        }
        return left;
    }
    concat() {
        const nodes = [];
        while (!['RPAREN', 'UNION', 'EOF'].includes(this.peek()[0])) {
            nodes.push(this.repeat());
        }
        if (nodes.length === 0) return ['EPS'];
        let result = nodes[0];
        for (let i = 1; i < nodes.length; i++) {
            result = ['CONCAT', result, nodes[i]];
        }
        return result;
    }
    repeat() {
        let node = this.atom();
        while (['STAR', 'PLUS', 'OPT'].includes(this.peek()[0])) {
            const op = this.consume()[0];
            if (op === 'STAR') node = ['STAR', node];
            else if (op === 'PLUS') node = ['PLUS', node];
            else node = ['OPT', node];
        }
        return node;
    }
    atom() {
        const t = this.peek();
        if (t[0] === 'LPAREN') {
            this.consume('LPAREN');
            const node = this.expr();
            this.consume('RPAREN');
            return node;
        }
        if (t[0] === 'SYM') { this.consume(); return ['SYM', t[1]]; }
        if (t[0] === 'CLASS') { this.consume(); return ['CLASS', t[1]]; }
        if (t[0] === 'DOT') { this.consume(); return ['DOT']; }
        if (t[0] === 'EPS') { this.consume(); return ['EPS']; }
        throw new ParseError(`Unexpected token: ${t[0]}`);
    }
}

function parse(s) {
    if (!s.trim()) return ['EPS'];
    const toks = tokenize(s);
    if (toks.length === 0) return ['EPS'];
    const parser = new Parser([...toks, ['EOF']]);
    return parser.parse();
}

// ─────────────────────────────────────────────
//  STRING GENERATOR  (BFS over AST)
// ─────────────────────────────────────────────
function genStrings(node, maxlen) {
    const results = new Set();
    const queue = [{ node, prefix: '', budget: maxlen }];
    
    while (queue.length) {
        const { node: n, prefix, budget } = queue.shift();
        const type = n[0];
        
        if (type === 'EPS') {
            if (prefix.length <= maxlen) results.add(prefix);
        }
        else if (type === 'SYM') {
            const s2 = prefix + n[1];
            if (s2.length <= maxlen) results.add(s2);
        }
        else if (type === 'DOT') {
            for (const c of ALPHABET) {
                const s2 = prefix + c;
                if (s2.length <= maxlen) results.add(s2);
            }
        }
        else if (type === 'CLASS') {
            const chars = Array.from(n[1]).sort();
            for (const c of chars) {
                const s2 = prefix + c;
                if (s2.length <= maxlen) results.add(s2);
            }
        }
        else if (type === 'UNION') {
            queue.push({ node: n[1], prefix, budget });
            queue.push({ node: n[2], prefix, budget });
        }
        else if (type === 'CONCAT') {
            const leftStrings = genStrings(n[1], maxlen - prefix.length);
            for (const leftStr of leftStrings) {
                if (prefix.length + leftStr.length <= maxlen) {
                    queue.push({ node: n[2], prefix: prefix + leftStr, budget: maxlen });
                }
            }
        }
        else if (type === 'STAR' || type === 'PLUS') {
            const inner = n[1];
            const base = genStrings(inner, maxlen - prefix.length);
            if (type === 'STAR' && prefix.length <= maxlen) results.add(prefix);
            
            let cur = type === 'STAR' ? new Set(['']) : new Set(Array.from(base).filter(b => b));
            for (const s of cur) {
                if (prefix.length + s.length <= maxlen) results.add(prefix + s);
            }
            for (let rep = 1; rep <= maxlen; rep++) {
                const nextSet = new Set();
                for (const s of cur) {
                    for (const b of base) {
                        const ns = s + b;
                        if (ns.length <= maxlen - prefix.length) nextSet.add(ns);
                    }
                }
                if (nextSet.size === 0) break;
                for (const s of nextSet) {
                    if (prefix.length + s.length <= maxlen) results.add(prefix + s);
                }
                cur = nextSet;
            }
        }
        else if (type === 'OPT') {
            results.add(prefix);
            queue.push({ node: n[1], prefix, budget });
        }
    }
    return results;
}

function safeGen(reStr, maxlen) {
    const node = parse(reStr);
    const strings = genStrings(node, maxlen);
    return Array.from(strings).sort((a, b) => {
        if (a.length !== b.length) return a.length - b.length;
        return a < b ? -1 : (a > b ? 1 : 0);
    });
}

// ─────────────────────────────────────────────
//  NFA  (Thompson's Construction)
// ─────────────────────────────────────────────
class NFA {
    constructor() {
        this.states = 0;
        this.start = 0;
        this.accept = 0;
        this.trans = {}; // { state: { sym: [states] } }
    }
    newState() {
        const s = this.states;
        this.states++;
        return s;
    }
    add(from, sym, to) {
        if (!this.trans[from]) this.trans[from] = {};
        if (!this.trans[from][sym]) this.trans[from][sym] = [];
        this.trans[from][sym].push(to);
    }
    epsilonClosure(states) {
        const closure = new Set(states);
        const stack = Array.from(states);
        while (stack.length) {
            const s = stack.pop();
            const epsTrans = (this.trans[s] && this.trans[s]['ε']) || [];
            for (const t of epsTrans) {
                if (!closure.has(t)) {
                    closure.add(t);
                    stack.push(t);
                }
            }
        }
        return closure;
    }
    move(states, sym) {
        const result = new Set();
        for (const s of states) {
            const trans = (this.trans[s] && this.trans[s][sym]) || [];
            for (const t of trans) result.add(t);
        }
        return result;
    }
}

function buildNFA(node) {
    const nfa = new NFA();
    const [start, accept] = build(nfa, node);
    nfa.start = start;
    nfa.accept = accept;
    return nfa;
}

function build(nfa, node) {
    const type = node[0];
    if (type === 'EPS') {
        const s = nfa.newState();
        const e = nfa.newState();
        nfa.add(s, 'ε', e);
        return [s, e];
    }
    else if (type === 'SYM') {
        const s = nfa.newState();
        const e = nfa.newState();
        nfa.add(s, node[1], e);
        return [s, e];
    }
    else if (type === 'DOT') {
        const s = nfa.newState();
        const e = nfa.newState();
        for (const c of ALPHABET) nfa.add(s, c, e);
        return [s, e];
    }
    else if (type === 'CLASS') {
        const s = nfa.newState();
        const e = nfa.newState();
        for (const c of node[1]) nfa.add(s, c, e);
        return [s, e];
    }
    else if (type === 'UNION') {
        const s = nfa.newState();
        const e = nfa.newState();
        const [s1, e1] = build(nfa, node[1]);
        const [s2, e2] = build(nfa, node[2]);
        nfa.add(s, 'ε', s1);
        nfa.add(s, 'ε', s2);
        nfa.add(e1, 'ε', e);
        nfa.add(e2, 'ε', e);
        return [s, e];
    }
    else if (type === 'CONCAT') {
        const [s1, e1] = build(nfa, node[1]);
        const [s2, e2] = build(nfa, node[2]);
        nfa.add(e1, 'ε', s2);
        return [s1, e2];
    }
    else if (type === 'STAR') {
        const s = nfa.newState();
        const e = nfa.newState();
        const [si, ei] = build(nfa, node[1]);
        nfa.add(s, 'ε', si);
        nfa.add(s, 'ε', e);
        nfa.add(ei, 'ε', si);
        nfa.add(ei, 'ε', e);
        return [s, e];
    }
    else if (type === 'PLUS') {
        const s = nfa.newState();
        const e = nfa.newState();
        const [si, ei] = build(nfa, node[1]);
        nfa.add(s, 'ε', si);
        nfa.add(ei, 'ε', si);
        nfa.add(ei, 'ε', e);
        return [s, e];
    }
    else if (type === 'OPT') {
        const s = nfa.newState();
        const e = nfa.newState();
        const [si, ei] = build(nfa, node[1]);
        nfa.add(s, 'ε', si);
        nfa.add(s, 'ε', e);
        nfa.add(ei, 'ε', e);
        return [s, e];
    }
    else {
        const s = nfa.newState();
        const e = nfa.newState();
        nfa.add(s, 'ε', e);
        return [s, e];
    }
}

// ─────────────────────────────────────────────
//  NFA → DFA  (Subset Construction)
// ─────────────────────────────────────────────
function nfaToDFA(nfa, reStr) {
    // Determine alphabet from RE
    const alphaSet = new Set();
    for (const c of reStr) {
        if (ALPHABET.includes(c)) alphaSet.add(c);
    }
    let alpha = Array.from(alphaSet).sort();
    if (alpha.length === 0) alpha = ['a', 'b'];
    
    const startClosure = nfa.epsilonClosure(new Set([nfa.start]));
    const stateMap = new Map();
    stateMap.set(startClosure, 'q0');
    const queue = [startClosure];
    const dfaTrans = {};
    const dfaAccept = [];
    let idx = 1;
    
    while (queue.length) {
        const cur = queue.shift();
        const label = stateMap.get(cur);
        dfaTrans[label] = {};
        
        for (const sym of alpha) {
            const moved = nfa.move(cur, sym);
            const closure = nfa.epsilonClosure(moved);
            if (closure.size === 0) {
                dfaTrans[label][sym] = 'qdead';
            } else {
                let newLabel = stateMap.get(closure);
                if (!newLabel) {
                    newLabel = 'q' + idx;
                    idx++;
                    stateMap.set(closure, newLabel);
                    queue.push(closure);
                }
                dfaTrans[label][sym] = newLabel;
            }
        }
        if (cur.has(nfa.accept)) dfaAccept.push(label);
    }
    
    // Add dead state
    dfaTrans['qdead'] = {};
    for (const sym of alpha) dfaTrans['qdead'][sym] = 'qdead';
    
    const allStates = [...new Set([...Array.from(stateMap.values()), 'qdead'])];
    
    // Remove unreachable states
    const reachable = new Set();
    const visited = new Set(['q0']);
    const stack = ['q0'];
    while (stack.length) {
        const s = stack.pop();
        reachable.add(s);
        for (const sym of alpha) {
            const t = (dfaTrans[s] && dfaTrans[s][sym]) || 'qdead';
            if (!visited.has(t)) {
                visited.add(t);
                stack.push(t);
            }
        }
    }
    const states = allStates.filter(s => reachable.has(s));
    
    return {
        states: states,
        alphabet: alpha,
        start: 'q0',
        accept: dfaAccept.filter(a => states.includes(a)),
        transitions: Object.fromEntries(states.map(s => [s, dfaTrans[s] || {}])),
        re: reStr
    };
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ ok: true, version: '2.0-dfa-js' });
});

app.post('/gen', (req, res) => {
    try {
        let reStr = (req.body.re || '').trim();
        let mx = Math.max(0, Math.min(12, parseInt(req.body.mx) || 6));
        if (!reStr) return res.status(400).json({ error: 'Empty expression' });
        
        const strings = safeGen(reStr, mx);
        const truncated = strings.length > 250;
        res.json({ strings: strings.slice(0, 250), count: strings.length, truncated });
    } catch (err) {
        if (err instanceof ParseError) return res.status(400).json({ error: err.message });
        res.status(500).json({ error: 'Internal error: ' + err.message });
    }
});

app.post('/eq', (req, res) => {
    try {
        const re1 = (req.body.re1 || '').trim();
        const re2 = (req.body.re2 || '').trim();
        const mx = Math.max(0, Math.min(10, parseInt(req.body.mx) || 6));
        if (!re1 || !re2) return res.status(400).json({ error: 'Both expressions required' });
        
        const s1 = new Set(safeGen(re1, mx));
        const s2 = new Set(safeGen(re2, mx));
        const only1 = Array.from(s1).filter(x => !s2.has(x)).sort((a,b) => a.length - b.length || (a < b ? -1 : 1)).slice(0,20);
        const only2 = Array.from(s2).filter(x => !s1.has(x)).sort((a,b) => a.length - b.length || (a < b ? -1 : 1)).slice(0,20);
        
        res.json({
            equivalent: s1.size === s2.size && only1.length === 0 && only2.length === 0,
            c1: s1.size,
            c2: s2.size,
            only1,
            only2
        });
    } catch (err) {
        if (err instanceof ParseError) return res.status(400).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

app.post('/dfa', (req, res) => {
    try {
        const reStr = (req.body.re || '').trim();
        if (!reStr) return res.status(400).json({ error: 'Empty expression' });
        
        const node = parse(reStr);
        const nfa = buildNFA(node);
        const result = nfaToDFA(nfa, reStr);
        res.json(result);
    } catch (err) {
        if (err instanceof ParseError) return res.status(400).json({ error: err.message });
        res.status(500).json({ error: 'DFA build error: ' + err.message });
    }
});

const PORT = 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('╔══════════════════════════════════════╗');
    console.log('║   Automata Explorer Backend v2.0     ║');
    console.log('║   http://localhost:5000              ║');
    console.log('║   DFA endpoint: POST /dfa            ║');
    console.log('╚══════════════════════════════════════╝');
});