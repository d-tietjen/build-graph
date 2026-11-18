/* Compile-derived bounded trace projections and request-flow views. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TraceWaterfall = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function project(trace) {
    var events = Array.isArray(trace && trace.events) ? trace.events : [];
    var bars = [], markers = [], stack = [], nextId = 1;
    function closeFrom(depth, step, outcome, all) {
      for (var d = stack.length - 1; d >= depth; d--) {
        var bar = stack[d]; if (!bar) continue;
        bar.end = Math.max(bar.start, step);
        bar.outcome = (all || d === depth) && outcome ? outcome :
          bar.tailPending ? 'tail call' : bar.unavailable ? 'body unavailable / recorded continuation' : 'implicit continuation';
        var continuation = events[step + 1];
        if (continuation && continuation.continuationId && continuation.callsiteId === bar.callsiteId) {
          bar.continuationId = continuation.continuationId; bar.summaryId = continuation.summaryId;
        }
      }
      stack.length = Math.max(0, depth);
    }
    events.forEach(function (e, step) {
      if (!e || typeof e !== 'object') return;
      var depth = Math.max(0, Number.isInteger(e.depth) ? e.depth : 0);
      if (e.type === 'enter') {
        if (stack.length > depth) closeFrom(depth, step - 1);
        var parent = depth ? stack[depth - 1] : null;
        var invocation = events[step - 1];
        var bar = { id: nextId++, parentId: parent ? parent.id : null,
          function: e.function || '(unknown)', depth: depth, start: step, end: step,
          outcome: 'open', via: e.via || (depth ? 'call' : 'entry'), recursive: !!e.recursive,
          source_file: e.source_file || null, source_location: e.source_location || null,
          callsiteId: invocation && (invocation.type === 'call' || invocation.type === 'tail_call') ? invocation.callsiteId : null,
          seenBlocks: new Set(), unavailable: false, tailPending: false };
        bars.push(bar); stack[depth] = bar; stack.length = depth + 1;
        if (e.via === 'callback') markers.push({ step: step, type: 'callback', label: 'callback invocation',
          activationId: bar.id, depth: depth, function: bar.function,
          source_file: bar.source_file, source_location: bar.source_location });
        if (bar.recursive) markers.push({ step: step, type: 'recursion', label: 'recursive activation',
          activationId: bar.id, depth: depth, function: bar.function,
          source_file: bar.source_file, source_location: bar.source_location });
        return;
      }
      if (stack.length > depth + 1) closeFrom(depth + 1, step - 1);
      var active = stack[depth] || stack[stack.length - 1] || null;
      var base = { step: step, activationId: active ? active.id : null, depth: depth,
        function: e.function || active && active.function || '(unknown)',
        source_file: e.source_file || active && active.source_file || null,
        source_location: e.source_location || active && active.source_location || null };
      function mark(type, label) { markers.push(Object.assign({}, base, { type: type, label: label })); }
      var prior = events[step - 1];
      var auxiliaryOpaque = e.type === 'opaque' && prior &&
        (prior.type === 'call' || prior.type === 'tail_call') &&
        prior.function === e.function && prior.block === e.block && prior.depth === e.depth;
      var externalBody = e.type === 'body_unavailable' && e.callee &&
        e.callee !== e.function;
      var next = events[step + 1];
      var followedByEntry = next && next.type === 'enter';
      var followedByOpaque = next && next.type === 'opaque' &&
        next.function === e.function && next.block === e.block && next.depth === e.depth;
      var followedBySummary = next && next.type === 'summarized_invocation' && next.callee &&
        next.callsiteId === e.callsiteId && next.summaryId && next.summaryOutcome;
      var unexpandedCall = (e.type === 'call' || e.type === 'tail_call') &&
        !followedByEntry && !followedByOpaque && !followedBySummary;
      if (active && e.type === 'summarized_invocation' && prior &&
          (prior.type === 'call' || prior.type === 'tail_call') && prior.callsiteId === e.callsiteId && e.callee) {
        var summaryParent = active, summaryDepth = active.depth + 1;
        if (prior.type === 'tail_call') {
          closeFrom(depth, step - 1); summaryParent = stack[depth - 1]; summaryDepth = depth;
        }
        bars.push({ id: nextId++, parentId: summaryParent ? summaryParent.id : null,
          function: e.callee, depth: summaryDepth, start: step, end: step,
          outcome: e.summaryOutcome === 'normal' ? 'return' : e.summaryOutcome === 'prefix' ? 'ordered prefix' : e.summaryOutcome,
          via: prior.callback ? 'callback' : 'call', summarized: true, summaryId: e.summaryId,
          callsiteId: e.callsiteId, continuationId: e.continuationId,
          caller: prior.function, callKind: prior.type, summaryOutcome: e.summaryOutcome,
          callSource: { source_file: prior.source_file, source_location: prior.source_location },
          source_file: e.source_file || null, source_location: e.source_location || null });
      }
      if (active && (externalBody || auxiliaryOpaque)) bars.push({
        id: nextId++, parentId: active.id,
        function: externalBody ? e.callee : '(unknown target)',
        depth: active.depth + 1, start: step, end: step,
        outcome: externalBody ? 'body unavailable / recorded continuation' :
          'unknown target / recorded continuation',
        via: 'boundary', synthetic: true, uncertain: true,
        source_file: (externalBody ? e : prior).source_file || e.source_file || null,
        source_location: (externalBody ? e : prior).source_location || e.source_location || null
      });
      if (active && unexpandedCall) bars.push({
        id: nextId++, parentId: active.id,
        function: e.callee || '(unexpanded target)',
        depth: active.depth + 1, start: step, end: step,
        outcome: 'unexpanded / bounded call', via: 'boundary',
        callKind: e.type, synthetic: true, uncertain: true, unexpanded: true,
        source_file: e.source_file || null, source_location: e.source_location || null
      });
      var routingBranch = e.type === 'branch' &&
        (Object.prototype.hasOwnProperty.call(e, 'branch') || e.edgeKind != null || e.target != null);
      if (active && e.block && !routingBranch && !auxiliaryOpaque) {
        if (active.seenBlocks.has(e.block)) mark('loop', 'revisited ' + e.block);
        else active.seenBlocks.add(e.block);
      }
      if (routingBranch) mark(e.edgeKind === 'unwind' ? 'unwind_edge' : 'branch',
        (e.branch || 'branch') + (e.target ? ' → ' + e.target : ''));
      else if (e.type === 'branch') mark('decision', e.label || 'branch decision');
      else if (e.type === 'body_unavailable') {
        if (active && !externalBody) active.unavailable = true;
        mark('unavailable', e.callee || e.label || 'body unavailable');
      } else if (e.type === 'opaque') mark('unknown', e.label || 'unknown target or boundary');
      else if (e.type === 'tail_call') {
        if (active) active.tailPending = true;
        mark('tail_call', e.callee || 'tail call');
      } else if (e.type === 'call' && e.callback_reference) mark('candidate',
        'callback argument is a reference, not a proven invocation');
      else if (e.type === 'unwind' || e.type === 'abort' || e.type === 'return') {
        mark(e.type, e.type);
        if (stack[depth]) closeFrom(depth, step, e.type);
      } else if (e.type === 'yield') mark('unknown', 'yield / resume boundary');
    });
    if (stack.length) closeFrom(0, Math.max(0, events.length - 1),
      trace && trace.reachedExit ? 'recorded exit' : 'open / truncated boundary',
      !(trace && trace.reachedExit));
    bars.forEach(function (bar) { delete bar.seenBlocks; delete bar.unavailable; delete bar.tailPending; });
    return { bars: bars, markers: markers, steps: events.length,
      reachedExit: !!(trace && trace.reachedExit), complete: !!(trace && trace.complete),
      coveragePartial: !!(trace && trace.coveragePartial), reasons: trace && trace.reasons || [],
      functions: trace && trace.functions || [],
      counts: { activations: bars.length,
        branches: markers.filter(function (m) { return m.type === 'branch'; }).length,
        loops: markers.filter(function (m) { return m.type === 'loop'; }).length,
        unwinds: markers.filter(function (m) { return m.type === 'unwind' || m.type === 'unwind_edge'; }).length,
        unknown: markers.filter(function (m) { return m.type === 'unknown' || m.type === 'unavailable'; }).length } };
  }

  // Sum projected event spans by logical call stack. Widths count compiled events
  // in bounded examples; a parent's inclusive width contains its child widths.
  function aggregate(variants) {
    var nextId = 1;
    var rootNode = { id: 0, parentId: null, function: null, via: null, depth: -1,
      children: [], weight: 0, selfSteps: 0, invocations: 0, traceCount: 0,
      unknownCount: 0, boundaryCount: 0, representative: null };
    (variants || []).forEach(function (variant) {
      var byBar = new Map(), seen = new Set();
      var steps = Math.max(0, variant.steps || 0);
      rootNode.weight += steps; rootNode.selfSteps += steps; rootNode.traceCount++;
      (variant.bars || []).forEach(function (bar) {
        var parent = byBar.get(bar.parentId) || rootNode;
        var node = parent.children.find(function (child) {
          return child.function === bar.function && child.via === bar.via;
        });
        if (!node) {
          node = { id: nextId++, parentId: parent.id, function: bar.function,
            via: bar.via, depth: parent.depth + 1, children: [], weight: 0,
            selfSteps: 0, invocations: 0, traceCount: 0, unknownCount: 0,
            boundaryCount: 0, representative: null };
          parent.children.push(node);
        }
        var width = Math.max(0, bar.end - bar.start + 1);
        node.weight += width; node.selfSteps += width; parent.selfSteps -= width;
        node.invocations++;
        if (!seen.has(node.id)) { node.traceCount++; seen.add(node.id); }
        if (bar.uncertain || bar.outcome === 'open / truncated boundary' ||
            bar.outcome.indexOf('unavailable') >= 0) node.boundaryCount++;
        node.uncertain = !!(node.uncertain || bar.uncertain);
        if (!node.representative) node.representative = {
          step: bar.start, source_file: bar.source_file,
          source_location: bar.source_location, outcome: bar.outcome
        };
        byBar.set(bar.id, node);
      });
      (variant.markers || []).forEach(function (marker) {
        if (marker.type === 'unknown' || marker.type === 'unavailable')
          (byBar.get(marker.activationId) || rootNode).unknownCount++;
      });
      if (!variant.reachedExit) rootNode.boundaryCount++;
    });
    return rootNode;
  }

  function orderedFrames(variant) {
    var steps = variant ? variant.steps : 0;
    var rootNode = { id: 0, parentId: null, function: null, via: null, depth: -1,
      start: 0, end: Math.max(0, steps - 1), children: [], weight: steps,
      selfSteps: steps, invocations: 0, traceCount: variant ? 1 : 0,
      unknownCount: 0, boundaryCount: variant && !variant.reachedExit ? 1 : 0 };
    var byBar = new Map();
    (variant && variant.bars || []).forEach(function (bar) {
      var parent = byBar.get(bar.parentId) || rootNode;
      var width = Math.max(0, bar.end - bar.start + 1);
      var node = { id: bar.id, parentId: parent.id, function: bar.function,
        via: bar.via, depth: bar.depth, start: bar.start, end: bar.end,
        children: [], weight: width, selfSteps: width, invocations: 1,
        traceCount: 1, uncertain: !!bar.uncertain, synthetic: !!bar.synthetic,
        summarized: !!bar.summarized, summaryOutcome: bar.summaryOutcome,
        callsiteId: bar.callsiteId, continuationId: bar.continuationId, summaryId: bar.summaryId,
        unknownCount: 0, boundaryCount: bar.uncertain ||
          bar.outcome === 'open / truncated boundary' ||
          bar.outcome.indexOf('unavailable') >= 0 ? 1 : 0,
        representative: { step: bar.start, source_file: bar.source_file,
          source_location: bar.source_location, outcome: bar.outcome, summarized: !!bar.summarized,
          summaryOutcome: bar.summaryOutcome, callsiteId: bar.callsiteId, continuationId: bar.continuationId } };
      parent.children.push(node); parent.selfSteps -= width; byBar.set(bar.id, node);
    });
    (variant && variant.markers || []).forEach(function (marker) {
      if (marker.type === 'unknown' || marker.type === 'unavailable')
        (byBar.get(marker.activationId) || rootNode).unknownCount++;
    });
    return rootNode;
  }

  function richestVariantIndex(variants) {
    var best = 0, most = -1;
    (variants || []).forEach(function (variant, i) {
      var count = (variant.bars || []).length;
      if (count > most) { best = i; most = count; }
    });
    return best;
  }

  function frameAt(tree, id) {
    if (tree.id === id) return tree;
    for (var i = 0; i < tree.children.length; i++) {
      var found = frameAt(tree.children[i], id);
      if (found) return found;
    }
    return null;
  }

  // A sequence diagram describes one recorded bounded variant, never a stitched
  // order across alternatives. Activation IDs and parent links come from project().
  function sequenceProject(trace, projection) {
    projection = projection || project(trace);
    var events = Array.isArray(trace && trace.events) ? trace.events : [];
    var participants = [], byName = new Map(), byId = new Map();
    var messages = [], fragments = [], notes = [];
    function participant(name, opaque) {
      if (!byName.has(name)) {
        var item = { id: name, opaque: !!opaque };
        byName.set(name, item); participants.push(item);
      } else if (!opaque) byName.get(name).opaque = false;
    }
    projection.bars.forEach(function (bar) {
      byId.set(bar.id, bar); participant(bar.function, !!bar.synthetic);
    });
    var activations = projection.bars.map(function (bar) {
      var sameFunctionParents = 0, parent = byId.get(bar.parentId);
      while (parent) {
        if (parent.function === bar.function) sameFunctionParents++;
        parent = byId.get(parent.parentId);
      }
      return { id: bar.id, parentId: bar.parentId, function: bar.function,
        start: bar.start, end: bar.end, outcome: bar.outcome, via: bar.via,
        synthetic: !!bar.synthetic, summarized: !!bar.summarized,
        callsiteId: bar.callsiteId || null, continuationId: bar.continuationId || null, summaryId: bar.summaryId || null,
        recursiveOffset: sameFunctionParents, source_file: bar.source_file,
        source_location: bar.source_location };
    });
    projection.bars.forEach(function (bar) {
      if (bar.summarized) {
        var summaryParent = byId.get(bar.parentId), continuation = events[bar.end + 1];
        var exact = { activationId: bar.id, callsiteId: bar.callsiteId,
          continuationId: bar.continuationId, summaryId: bar.summaryId, summaryOutcome: bar.summaryOutcome };
        messages.push(Object.assign({ type: bar.callKind, from: bar.caller, to: bar.function,
          step: bar.start, label: 'call (fixed-point summary)',
          source_file: bar.callSource.source_file, source_location: bar.callSource.source_location }, exact));
        if (summaryParent && (bar.outcome === 'return' || bar.outcome === 'unwind')) messages.push(Object.assign({
          type: bar.outcome, from: bar.function, to: summaryParent.function, step: bar.end,
          label: bar.outcome + ' (proven ' + bar.summaryOutcome + ' summary)',
          source_file: bar.source_file, source_location: bar.source_location }, exact));
        if (summaryParent && continuation && continuation.type === 'branch' && bar.continuationId &&
            continuation.continuationId === bar.continuationId && continuation.callsiteId === bar.callsiteId)
          messages.push(Object.assign({ type: 'continuation', from: bar.function, to: summaryParent.function,
            step: bar.end + 1, label: 'proven ' + bar.summaryOutcome + ' continuation',
            source_file: continuation.source_file, source_location: continuation.source_location }, exact));
        notes.push({ step: bar.start, function: bar.function, label: 'known invocation; body retained as fixed-point summary' });
        return;
      }
      if (bar.synthetic) {
        if (bar.unexpanded) {
          var boundedCaller = byId.get(bar.parentId);
          if (boundedCaller) messages.push({
            type: bar.callKind === 'tail_call' ? 'tail_call' : 'call',
            from: boundedCaller.function, to: bar.function, step: bar.start,
            activationId: bar.id, label: 'unexpanded call at recorded bound',
            source_file: bar.source_file, source_location: bar.source_location
          });
          notes.push({ step: bar.start, function: bar.function,
            label: 'callee not entered; no recorded return' });
        }
        return;
      }
      var previous = events[bar.start - 1], parent = byId.get(bar.parentId);
      var tail = previous && previous.type === 'tail_call' &&
        projection.bars.find(function (prior) {
          return prior.end === bar.start - 1 && prior.outcome === 'tail call' &&
            prior.function === previous.function;
        });
      var caller = tail || parent;
      if (caller && previous && (previous.type === 'call' || previous.type === 'tail_call') &&
          previous.function === caller.function) {
        messages.push({ type: previous.type === 'tail_call' ? 'tail_call' : 'call',
          from: caller.function, to: bar.function, step: bar.start,
          activationId: bar.id, label: previous.type === 'tail_call' ? 'tail call' :
            bar.via === 'callback' ? 'callback invocation' :
            bar.via === 'possible-dispatch' ? 'possible dispatch' : 'call',
          source_file: previous.source_file || bar.source_file,
          source_location: previous.source_location || bar.source_location,
          callsiteId: bar.callsiteId || null, continuationId: bar.continuationId || null, summaryId: bar.summaryId || null });
      }
      if (parent && (bar.outcome === 'return' || bar.outcome === 'unwind')) {
        messages.push({ type: bar.outcome, from: bar.function, to: parent.function,
          step: bar.end, activationId: bar.id, label: bar.outcome,
          source_file: events[bar.end] && events[bar.end].source_file || bar.source_file,
          source_location: events[bar.end] && events[bar.end].source_location || bar.source_location,
          callsiteId: bar.callsiteId || null, continuationId: bar.continuationId || null, summaryId: bar.summaryId || null });
      }
      if (bar.outcome === 'open / truncated boundary') notes.push({ step: bar.end,
        function: bar.function, label: 'open bound; no recorded return' });
      if (bar.outcome.indexOf('unavailable') >= 0) {
        notes.push({ step: bar.end, function: bar.function,
          label: 'body unavailable; recorded continuation only' });
        var continuation = events[bar.end + 1];
        if (parent && continuation && continuation.type === 'branch' &&
            continuation.function === parent.function) messages.push({
          type: 'continuation', from: bar.function, to: parent.function,
          step: bar.end + 1, activationId: bar.id,
          label: 'recorded continuation; body unknown',
          source_file: continuation.source_file,
          source_location: continuation.source_location });
      }
    });
    events.forEach(function (event, step) {
      if (!event) return;
      var prior = events[step - 1], after = events[step + 1];
      var external = event.type === 'body_unavailable' && event.callee &&
        event.callee !== event.function;
      var unknown = event.type === 'opaque' && prior &&
        (prior.type === 'call' || prior.type === 'tail_call') &&
        prior.function === event.function && prior.depth === event.depth;
      if (external || unknown) {
        var target = external ? event.callee : '(unknown target)';
        participant(event.function, false); participant(target, true);
        messages.push({ type: 'opaque_call', from: event.function, to: target,
          step: external ? step : step - 1, label: external ? 'body unavailable' :
            'unknown target', source_file: event.source_file,
          source_location: event.source_location });
        if (after && after.type === 'branch' && after.function === event.function &&
            after.depth === event.depth) messages.push({ type: 'continuation',
          from: target, to: event.function, step: step + 1,
          label: 'recorded continuation; body unknown', source_file: after.source_file,
          source_location: after.source_location });
        else notes.push({ step: step, function: event.function,
          label: 'unknown body; no recorded continuation' });
      }
      if (event.type === 'call' && event.callback_reference)
        notes.push({ step: step, function: event.function,
          label: 'callback reference; invocation not proven' });
      if (event.type === 'branch' && event.branch && event.branch !== 'next' &&
          event.branch !== 'return') fragments.push({ type: 'guard', step: step,
            label: 'opt [selected ' + event.branch + (event.target ? ' → ' + event.target : '') + ']' });
    });
    projection.markers.forEach(function (marker) {
      if (marker.type === 'loop') fragments.push({ type: 'loop', step: marker.step,
        label: 'loop [observed ' + marker.label + ']' });
    });
    messages.sort(function (a, b) { return a.step - b.step; });
    return { participants: participants, activations: activations,
      messages: messages, fragments: fragments, notes: notes,
      steps: projection.steps, reachedExit: projection.reachedExit,
      reasons: projection.reasons, coveragePartial: projection.coveragePartial };
  }

  function mount(doc, hooks) {
    var side = doc.getElementById('waterfall-side'), stage = doc.getElementById('waterfall-stage');
    var entry = doc.getElementById('waterfall-entry'), panic = doc.getElementById('waterfall-unwind');
    var status = doc.getElementById('waterfall-status'), pinsBox = doc.getElementById('waterfall-pins');
    var compare = doc.getElementById('waterfall-compare'), select = doc.getElementById('waterfall-variant-select');
    var detail = doc.getElementById('waterfall-detail'), info = doc.getElementById('waterfall-info');
    var notes = doc.getElementById('waterfall-diagnostics'), active = false, roots = [];
    var pins = [], focused = null, result = null, variants = [], sequences = [], selected = 0;
    var mode = 'flamegraph', flameLayout = 'order', flame = aggregate([]), ordered = [];
    var zoomId = 0, lastFlameWidth = 0;
    var selectRow = doc.getElementById('waterfall-select-row');
    var head = doc.getElementById('waterfall-head');
    var modeControls = doc.createElement('span');
    var sequenceButton = doc.createElement('button'), flameButton = doc.createElement('button');
    var backButton = doc.createElement('button'), macroButton = doc.createElement('button');
    var resetZoomButton = doc.createElement('button');
    var orderButton = doc.createElement('button'), mergedButton = doc.createElement('button');
    var zoomLabel = doc.createElement('span');
    var hoverStatus = doc.createElement('div'), plotCounts = doc.createElement('div');
    sequenceButton.type = flameButton.type = backButton.type = macroButton.type =
      resetZoomButton.type = orderButton.type = mergedButton.type = 'button';
    sequenceButton.textContent = 'UML sequence'; flameButton.textContent = 'Flamegraph';
    orderButton.textContent = 'Call order'; mergedButton.textContent = 'Merged stacks';
    backButton.textContent = 'Back one stack';
    resetZoomButton.textContent = 'Reset zoom';
    macroButton.textContent = 'Back to macro graph';
    modeControls.appendChild(flameButton); modeControls.appendChild(sequenceButton);
    modeControls.appendChild(orderButton); modeControls.appendChild(mergedButton);
    modeControls.appendChild(backButton); modeControls.appendChild(resetZoomButton);
    modeControls.appendChild(macroButton);
    modeControls.appendChild(zoomLabel);
    modeControls.style.marginRight = '14px';
    selectRow.replaceChildren(modeControls, ' Inspect bounded variant ', select,
      ' · selector includes every returned bounded example.');
    hoverStatus.id = 'flame-hover-status'; head.appendChild(hoverStatus);
    plotCounts.id = 'flame-plot-counts'; head.appendChild(plotCounts);
    var ns = 'http://www.w3.org/2000/svg';
    var palette = { entry: '#75d2ba', call: '#5daee0', callback: '#b99cff',
      'possible-dispatch': '#e5ba64' };
    var markerColor = { branch: '#e1b95e', loop: '#e8c04a', callback: '#bc9aff',
      recursion: '#d790f0', unwind: '#ef9a5b', unwind_edge: '#ef9a5b',
      unavailable: '#e2ad6c', unknown: '#e2ad6c', candidate: '#9ca8b3',
      tail_call: '#91b7e2', return: '#77d7a9', abort: '#ee7474' };
    function el(tag, attrs, label) {
      var n = doc.createElementNS(ns, tag);
      Object.keys(attrs || {}).forEach(function (key) { n.setAttribute(key, attrs[key]); });
      if (label != null) n.textContent = label;
      return n;
    }
    function shortName(name) { var parts = String(name || '').split('::'); return parts.slice(-2).join('::'); }
    function flameColor(name) {
      var hash = 2166136261;
      for (var i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
      return 'hsl(' + (Math.abs(hash) % 55) + ' 88% ' + (62 + Math.abs(hash >>> 8) % 13) + '%)';
    }
    function percent(part, whole) { return whole ? (100 * part / whole).toFixed(1) + '%' : '0%'; }
    function pinText() {
      pinsBox.replaceChildren();
      pinsBox.textContent = pins.length ? pins.join(' · ') : 'No AND pins; showing bounded examples from the selected entry.';
    }
    function ask() {
      if (!active || !entry.value) return;
      if (result && result.orderedEvidence) notes.replaceChildren();
      result = null; variants = []; sequences = []; ordered = []; selected = 0;
      flame = aggregate([]); zoomId = 0;
      compare.replaceChildren(); select.replaceChildren(); detail.replaceChildren(); sourceInfo(null);
      status.textContent = 'Exploring bounded compiler paths…';
      hooks.query({ root: entry.value, pins: pins.slice(), includeUnwind: panic.checked,
        maxPaths: 24, maxSteps: 160, maxVisits: 2, maxDepth: 12, maxStates: 30000 });
    }
    function setCatalog(model, quiet) {
      clearWitness();
      roots = model && model.roots && model.roots.application || [];
      if (focused && Array.isArray(model.procedures) &&
          !model.procedures.some(function (procedure) { return procedure.id === focused; })) focused = null;
      var previous = entry.value; entry.replaceChildren();
      roots.forEach(function (path) { var option = doc.createElement('option'); option.value = path;
        option.textContent = path + ' · compiled entry'; entry.appendChild(option); });
      if (focused && roots.indexOf(focused) < 0) {
        var local = doc.createElement('option'); local.value = focused;
        local.textContent = focused + ' · focused local witness'; entry.appendChild(local);
      }
      if (previous && Array.from(entry.options).some(function (opt) { return opt.value === previous; })) entry.value = previous;
      else if (focused) entry.value = focused;
      else if (roots.length) entry.value = roots[0];
      if (active && !quiet) ask();
    }
    function open(path, currentPins, nextMode) {
      if (nextMode === 'flamegraph') { flameLayout = 'order'; zoomId = 0; }
      if (nextMode) setMode(nextMode);
      focused = path || null;
      pins = Array.isArray(currentPins) ? currentPins.slice() : pins;
      pinText(); setCatalog({ roots: { application: roots } }, true);
      if (focused) {
        if (!Array.from(entry.options).some(function (opt) { return opt.value === focused; })) {
          var local = doc.createElement('option'); local.value = focused;
          local.textContent = focused + ' · focused local witness'; entry.appendChild(local);
        }
        entry.value = focused;
      }
      hooks.activate(); ask();
    }
    function setPins(next) { clearWitness(); pins = next.slice(); pinText(); if (active) ask(); }
    function activate(on) { active = on; }
    function sourceInfo(item) {
      info.replaceChildren();
      if (!item) { info.textContent = 'Select a span, frame, or decision marker for source and pin actions.'; return; }
      var title = doc.createElement('strong'); title.textContent = item.function || '(unknown)'; info.appendChild(title);
      var summary = doc.createElement('div');
      summary.textContent = item.aggregate ?
        (item.ordered ? 'Recorded invocation in selected variant' :
          item.invocations + ' activations in ' + item.traceCount + ' bounded examples') + ' · ' +
          item.weight + ' inclusive compiled event steps · ' + item.selfSteps + ' exclusive steps' +
          (item.boundaryCount ? ' · ' + item.boundaryCount + ' uncertain/open boundaries' : '') +
          (item.unknownCount ? ' · ' + item.unknownCount + ' unknown markers' : '') +
          (item.summarized ? ' · proven ' + item.summaryOutcome + ' summary' : '') +
          (item.callsiteId ? ' · callsite ' + item.callsiteId : '') +
          (item.continuationId ? ' · continuation ' + item.continuationId : '') +
          (item.source_file ? ' · example source ' + item.source_file +
            (item.source_location ? ':' + item.source_location : '') : ' · source unavailable') :
        'Compiled step ' + item.step +
          (item.label ? ' · ' + item.label : item.outcome ? ' · ' + item.outcome : '') +
          (item.source_file ? ' · ' + item.source_file +
            (item.source_location ? ':' + item.source_location : '') : ' · source unavailable');
      info.appendChild(summary);
      if (item.function && (!hooks.canPin || hooks.canPin(item.function))) {
        var pin = doc.createElement('button'); pin.textContent = pins.indexOf(item.function) >= 0 ? 'Remove AND pin' : 'AND pin procedure';
        pin.onclick = function () { hooks.pin(item.function); }; info.appendChild(pin);
      }
      if (item.function && item.function !== '(unknown)' &&
          (!hooks.canPin || hooks.canPin(item.function))) {
        var focus = doc.createElement('button');
        focus.textContent = item.aggregate || item.sequence ? 'Expand execution flow' : 'Show in full statechart';
        focus.onclick = function () {
          if (item.aggregate || item.sequence) hooks.execution(item.function);
          else hooks.focus(item.function);
        }; info.appendChild(focus);
      }
    }
    function mini(variant, index, sharedSteps) {
      var button = doc.createElement('button'); button.type = 'button';
      button.className = 'waterfall-variant' + (index === selected ? ' active' : '');
      var calls = variant.bars.filter(function (bar) { return bar.via !== 'entry'; });
      var boundaries = calls.filter(function (bar) {
        return bar.synthetic || bar.outcome.indexOf('unavailable') >= 0;
      }).length;
      var heading = doc.createElement('strong'); heading.textContent = 'Variant ' + (index + 1) +
        ' · ' + calls.length + ' call frames' +
        (variant.reachedExit ? ' · recorded exit' : ' · bound/boundary'); button.appendChild(heading);
      var sub = doc.createElement('div'); sub.textContent = calls.length - boundaries +
        ' known-body · ' + boundaries + ' opaque/boundary · ' + variant.steps +
        ' compiled event steps' + (variant.coveragePartial ? ' · partial coverage' : ''); button.appendChild(sub);
      var svg = el('svg', { viewBox: '0 0 300 90', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      var maxDepth = Math.max(1, variant.bars.reduce(function (n, bar) { return Math.max(n, bar.depth); }, 0));
      variant.bars.forEach(function (bar) {
        var x = 8 + 284 * bar.start / Math.max(1, sharedSteps), w = Math.max(2, 284 * (bar.end - bar.start + 1) / Math.max(1, sharedSteps));
        var y = 8 + 64 * bar.depth / (maxDepth + 1);
        svg.appendChild(el('rect', { x: x, y: y, width: w, height: 9, rx: 3,
          fill: flameColor(bar.function), opacity: bar.synthetic ? .55 : .85 }));
      });
      variant.markers.filter(function (m) { return ['branch', 'loop', 'unwind_edge', 'unknown', 'unavailable'].indexOf(m.type) >= 0; }).forEach(function (m) {
        var x = 8 + 284 * m.step / Math.max(1, sharedSteps);
        svg.appendChild(el('line', { x1: x, y1: 76, x2: x, y2: 85, stroke: markerColor[m.type] || '#9ca8b3', 'stroke-width': 2 }));
      });
      svg.appendChild(el('text', { x: 8, y: 89, fill: '#9db0c2', 'font-size': 8 }, '0'));
      svg.appendChild(el('text', { x: 260, y: 89, fill: '#9db0c2', 'font-size': 8 }, String(sharedSteps) + ' steps'));
      button.appendChild(svg); button.onclick = function () { selected = index; zoomId = 0; render(); }; return button;
    }
    function renderDetail(variant) {
      detail.replaceChildren(); sourceInfo(null);
      if (!variant) return;
      var stepWidth = 15, left = 190, rowHeight = 54;
      var maxDepth = variant.bars.reduce(function (n, bar) { return Math.max(n, bar.depth); }, 0);
      var w = Math.max(930, left + (variant.steps + 2) * stepWidth), h = Math.max(190, 105 + (maxDepth + 1) * rowHeight);
      detail.setAttribute('width', w); detail.setAttribute('height', h); detail.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      detail.appendChild(el('text', { x: 10, y: 24, fill: '#b9cddd', 'font-size': 12 },
        'Nested activations · compiled MIR event step, not time'));
      for (var step = 0; step <= variant.steps; step += 10) {
        var tick = left + step * stepWidth;
        detail.appendChild(el('line', { x1: tick, y1: 43, x2: tick, y2: h - 20,
          stroke: '#27384b', 'stroke-width': 1 }));
        detail.appendChild(el('text', { x: tick + 2, y: 40, fill: '#8ba4b8', 'font-size': 10 }, String(step)));
      }
      variant.bars.forEach(function (bar) {
        var x = left + bar.start * stepWidth, y = 60 + bar.depth * rowHeight;
        var bw = Math.max(11, (bar.end - bar.start + 1) * stepWidth);
        if (bar.parentId != null) detail.appendChild(el('line', { x1: x, y1: y - 30, x2: x, y2: y,
          stroke: '#607e9c', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
        detail.appendChild(el('text', { x: 9, y: y + 17, fill: '#9db5c8', 'font-size': 11 },
          'depth ' + bar.depth));
        var rect = el('rect', { x: x, y: y, width: bw, height: 28, rx: 6,
          fill: bar.outcome.indexOf('bound') >= 0 || bar.outcome.indexOf('unavailable') >= 0 ? '#5a4534' :
            palette[bar.via] || palette.call, opacity: .84, stroke: '#c8d7e4', 'stroke-width': .6 });
        rect.style.cursor = 'pointer'; rect.appendChild(el('title', {}, bar.function + ' · ' + bar.outcome));
        rect.onclick = function () { sourceInfo(Object.assign({ step: bar.start }, bar)); }; detail.appendChild(rect);
        if (bw >= 42) {
          var maxChars = Math.max(1, Math.floor((bw - 12) / 6.5));
          var name = shortName(bar.function) + (bar.via === 'possible-dispatch' ? ' ?' : '');
          if (name.length > maxChars) name = name.slice(0, Math.max(1, maxChars - 1)) + '…';
          detail.appendChild(el('text', { x: x + 6, y: y + 18, fill: '#0b1520', 'font-size': 11,
            'pointer-events': 'none' }, name));
        }
      });
      variant.markers.forEach(function (marker) {
        var x = left + marker.step * stepWidth, y = 61 + marker.depth * rowHeight;
        var circle = el('circle', { cx: x, cy: y + 34, r: 5, fill: markerColor[marker.type] || '#8ca9bc' });
        circle.style.cursor = 'pointer'; circle.appendChild(el('title', {}, marker.label));
        circle.onclick = function () { sourceInfo(marker); }; detail.appendChild(circle);
      });
      var end = el('text', { x: left, y: h - 5, fill: '#d0a975', 'font-size': 11 },
        variant.reasons.length ? variant.reasons.join(' · ').slice(0, 240) :
          variant.reachedExit ? (variant.coveragePartial ? 'Recorded exit with partial body coverage.' : 'Recorded exit.') :
            'Open boundary; execution beyond the recorded example is unknown.');
      detail.appendChild(end);
    }
    function currentFlame() {
      return flameLayout === 'order' ? ordered[selected] || orderedFrames(null) : flame;
    }
    function findFrame(id, node) {
      return frameAt(node || currentFlame(), id);
    }
    function flamePath() {
      var path = [], node = findFrame(zoomId);
      while (node && node.parentId != null) {
        path.unshift(node.function); node = findFrame(node.parentId);
      }
      return path;
    }
    function renderFlame(preserveInfo) {
      detail.replaceChildren();
      if (!preserveInfo) sourceInfo(null);
      var tree = currentFlame(), frame = findFrame(zoomId) || tree;
      var path = flamePath();
      zoomLabel.textContent = path.length ? ' Zoom: ' + path.map(shortName).join(' → ') :
        flameLayout === 'order' ? ' Selected variant' : ' All bounded examples';
      backButton.style.display = path.length ? '' : 'none';
      resetZoomButton.disabled = !path.length;
      hoverStatus.textContent = 'Hover a frame for compiled-event counts and uncertainty.';
      var w = Math.max(320, detail.parentElement.clientWidth || stage.clientWidth || 980,
        flameLayout === 'order' ? tree.weight * 12 + 16 : 0);
      lastFlameWidth = w;
      detail.style.width = flameLayout === 'order' ? w + 'px' : '100%';
      if (!tree.traceCount || !frame.weight) {
        detail.setAttribute('width', w); detail.setAttribute('height', 160);
        detail.setAttribute('viewBox', '0 0 ' + w + ' 160');
        detail.style.height = '160px';
        detail.appendChild(el('text', { x: 12, y: 58, fill: '#34302a', 'font-size': 13 },
          'No captured bounded trace frames to aggregate for this selection.'));
        return;
      }
      function height(node) {
        return 1 + node.children.reduce(function (max, child) { return Math.max(max, height(child)); }, 0);
      }
      var levels = height(frame), row = 18, h = 89 + levels * row;
      detail.setAttribute('width', w); detail.setAttribute('height', h);
      detail.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      detail.style.height = h + 'px';
      detail.appendChild(el('text', { x: 8, y: 21, fill: '#322c24', 'font-size': 12 },
        flameLayout === 'order' ?
          'Call order · selected bounded variant ' + (selected + 1) + ' of ' + variants.length +
          ' · width follows compiled-event positions, not time.' :
          'Merged stacks · inclusive compiled-event steps across ' + tree.traceCount +
          ' bounded examples, not runtime samples or time.'));
      detail.appendChild(el('text', { x: 8, y: 40, fill: '#5a4d40', 'font-size': 11 },
        flameLayout === 'order' ?
          'Every recorded invocation stays separate at its event position; open and unknown boundaries are uncertain.' :
          'Alphabetical stack grouping is not execution order. Open and unknown boundaries remain uncertain.'));
      var defs = el('defs'); detail.appendChild(defs);
      function draw(node, x, width, depth) {
        if (width <= 0) return;
        var y = 60 + (levels - depth - 1) * row;
        var fullName = node.function || 'All bounded examples';
        var detailText = fullName + ' · inclusive ' + node.weight + ' compiled-event steps (' +
          percent(node.weight, tree.weight) + ' of ' +
          (flameLayout === 'order' ? 'selected-variant' : 'all bounded-example') + ' steps; ' +
          percent(node.weight, frame.weight) + ' of current zoom)' +
          ' · self ' + node.selfSteps + ' steps (' + percent(node.selfSteps, tree.weight) +
          ' of ' + (flameLayout === 'order' ? 'selected-variant' : 'all bounded-example') +
          ' steps; ' + percent(node.selfSteps, node.weight) + ' of this frame)' +
          (node.id ? ' · ' + node.invocations + ' activations in ' + node.traceCount + ' examples' : '') +
          (node.summarized ? ' · proven ' + node.summaryOutcome + ' summary' : '') +
          (node.callsiteId ? ' · callsite ' + node.callsiteId : '') +
          (node.continuationId ? ' · continuation ' + node.continuationId : '') +
          (node.boundaryCount ? ' · ' + node.boundaryCount + ' uncertain/open boundaries' : '') +
          (node.unknownCount ? ' · ' + node.unknownCount + ' unknown markers' : '');
        var rect = el('rect', { x: x, y: y, width: width, height: 17, rx: 0,
          fill: node.id ? flameColor(node.function) : '#f0d59b',
          stroke: '#fff8ec', 'stroke-width': 1 });
        rect.onmouseenter = function () { hoverStatus.textContent = detailText; };
        rect.onmouseleave = function () { hoverStatus.textContent =
          'Hover a frame for compiled-event counts and uncertainty.'; };
        if (node.id) {
          rect.style.cursor = 'pointer';
          rect.setAttribute('role', 'button'); rect.setAttribute('tabindex', '0');
          rect.setAttribute('aria-label', 'Inspect and zoom ' + detailText);
          var inspect = function () {
            zoomId = node.id; renderFlame();
            sourceInfo(Object.assign({ function: node.function, aggregate: true,
              ordered: flameLayout === 'order',
              invocations: node.invocations, traceCount: node.traceCount,
              weight: node.weight, selfSteps: node.selfSteps,
              boundaryCount: node.boundaryCount, unknownCount: node.unknownCount },
            node.representative || {}));
          };
          rect.onclick = inspect;
          rect.onkeydown = function (event) {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(); }
          };
        }
        rect.appendChild(el('title', {}, detailText));
        detail.appendChild(rect);
        if (node.boundaryCount || node.unknownCount) detail.appendChild(el('line', {
          x1: x + 1, y1: y + 1, x2: x + width - 1, y2: y + 1,
          stroke: '#ab4735', 'stroke-width': 1, 'stroke-dasharray': '4 3',
          'pointer-events': 'none' }));
        if (width >= 24) {
          var clip = el('clipPath', { id: 'flame-clip-' + node.id });
          clip.appendChild(el('rect', { x: x + 3, y: y, width: Math.max(0, width - 6), height: 17 }));
          defs.appendChild(clip);
          detail.appendChild(el('text', { x: x + 4, y: y + 12, fill: '#2c251d',
            'font-size': 11, 'font-family': 'Verdana, sans-serif',
            'clip-path': 'url(#flame-clip-' + node.id + ')',
            'pointer-events': 'none' }, fullName));
        }
        var childX = x;
        var children = flameLayout === 'order' ? node.children : node.children.slice().sort(function (a, b) {
          return a.function.localeCompare(b.function) || a.via.localeCompare(b.via);
        });
        children.forEach(function (child) {
          var childWidth = width * child.weight / node.weight;
          var position = flameLayout === 'order' ?
            x + width * (child.start - node.start) / node.weight : childX;
          draw(child, position, childWidth, depth + 1);
          if (flameLayout !== 'order') childX += childWidth;
        });
      }
      draw(frame, 8, w - 16, 0);
      detail.appendChild(el('text', { x: 8, y: h - 11, fill: '#73583b', 'font-size': 11 },
        (result && result.truncated ? 'Search cap reached; more variants may exist. ' : '') +
        (flameLayout === 'order' ?
          'Only this selected bounded variant is plotted; continuation beyond its recorded bound is unknown.' :
          'Only captured bounded examples contribute to merged stacks.')));
    }
    function renderSequence(sequence) {
      detail.replaceChildren(); sourceInfo(null);
      detail.style.width = ''; detail.style.height = '';
      if (!sequence || !sequence.participants.length) {
        detail.setAttribute('width', 980); detail.setAttribute('height', 160);
        detail.setAttribute('viewBox', '0 0 980 160');
        detail.appendChild(el('text', { x: 16, y: 58, fill: '#b9cddd', 'font-size': 13 },
          'No recorded activation in this bounded variant.'));
        return;
      }
      var row = 38, top = 112;
      var w = Math.max(980, 180 + sequence.participants.length * 210);
      var h = top + Math.max(1, sequence.steps) * row + 65;
      var positions = new Map();
      sequence.participants.forEach(function (p, i) { positions.set(p.id, 120 + i * 210); });
      function yFor(step) { return top + step * row; }
      detail.setAttribute('width', w); detail.setAttribute('height', h);
      detail.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      var defs = el('defs');
      var arrow = el('marker', { id: 'sequence-arrow', markerWidth: 7, markerHeight: 7,
        refX: 6, refY: 3.5, orient: 'auto' });
      arrow.appendChild(el('path', { d: 'M 0 0 L 7 3.5 L 0 7 z', fill: '#b6cde0' }));
      defs.appendChild(arrow); detail.appendChild(defs);
      detail.appendChild(el('text', { x: 18, y: 24, fill: '#b9cddd', 'font-size': 12 },
        'UML sequence · variant ' + (selected + 1) + ' of ' + variants.length +
        ' bounded examples · vertical order is compiled MIR events, not time.'));
      detail.appendChild(el('text', { x: 18, y: 43, fill: '#9db5c8', 'font-size': 11 },
        'Only this selected path is ordered. Opaque bodies and open bounds do not imply a completed return.'));
      sequence.participants.forEach(function (p) {
        var x = positions.get(p.id), name = shortName(p.id);
        detail.appendChild(el('rect', { x: x - 79, y: 59, width: 158, height: 31,
          rx: 4, fill: p.opaque ? '#5a4534' : '#28485f', stroke: '#9eb7c9' }));
        detail.appendChild(el('text', { x: x, y: 79, fill: '#ecf4fa',
          'font-size': 11, 'text-anchor': 'middle' }, name));
        detail.appendChild(el('line', { x1: x, y1: 90, x2: x, y2: h - 42,
          stroke: '#819bae', 'stroke-width': 1, 'stroke-dasharray': '5 5' }));
      });
      sequence.fragments.forEach(function (fragment) {
        var y = yFor(fragment.step) - 13;
        detail.appendChild(el('rect', { x: 22, y: y, width: w - 44, height: 31,
          fill: 'none', stroke: fragment.type === 'loop' ? '#d790f0' : '#c9af6a',
          'stroke-width': 1, 'stroke-dasharray': '4 3' }));
        detail.appendChild(el('text', { x: 29, y: y + 12, fill: fragment.type === 'loop' ? '#dbaaf4' : '#ddc589',
          'font-size': 10 }, fragment.label));
      });
      sequence.activations.forEach(function (a) {
        var x = positions.get(a.function) + a.recursiveOffset * 13;
        var y = yFor(a.start) - 10;
        var rect = el('rect', { x: x - 6, y: y, width: 12,
          height: Math.max(20, (a.end - a.start + 1) * row - 8), rx: 2,
          fill: a.outcome.indexOf('unavailable') >= 0 ? '#806149' : '#5daee0',
          stroke: '#d8e7f2', 'stroke-width': 1,
          'stroke-dasharray': a.outcome === 'open / truncated boundary' ? '3 3' : 'none' });
        rect.style.cursor = 'pointer';
        rect.appendChild(el('title', {}, a.function + ' · activation ' + a.id + ' · ' + a.outcome));
        rect.onclick = function () { sourceInfo(Object.assign({ sequence: true,
          step: a.start, label: 'activation ' + a.id + ' · ' + a.outcome }, a)); };
        detail.appendChild(rect);
      });
      sequence.messages.forEach(function (m) {
        var from = positions.get(m.from), to = positions.get(m.to), y = yFor(m.step);
        if (from == null || to == null) return;
        var dashed = m.type === 'return' || m.type === 'unwind' || m.type === 'continuation';
        var attrs = { stroke: dashed ? '#d4ad78' : '#b6cde0',
          'stroke-width': 1.6, fill: 'none', 'marker-end': 'url(#sequence-arrow)' };
        if (dashed) attrs['stroke-dasharray'] = '6 4';
        if (from === to) detail.appendChild(el('path', Object.assign({
          d: 'M ' + from + ' ' + y + ' H ' + (from + 52) + ' V ' + (y + 13) +
            ' H ' + (from + 12) }, attrs)));
        else detail.appendChild(el('line', Object.assign({
          x1: from + (to > from ? 9 : -9), y1: y,
          x2: to + (to > from ? -9 : 9), y2: y }, attrs)));
        var textX = Math.min(from, to) + 15;
        detail.appendChild(el('text', { x: textX, y: y - 5, fill: dashed ? '#e4bd88' : '#dce9f2',
          'font-size': 10 }, m.label));
      });
      sequence.notes.forEach(function (note, i) {
        var x = positions.get(note.function);
        if (x == null) return;
        detail.appendChild(el('text', { x: x + 20, y: yFor(note.step) + 15 + i % 2 * 11,
          fill: '#d6a96b', 'font-size': 10 }, 'note: ' + note.label));
      });
      detail.appendChild(el('text', { x: 18, y: h - 15, fill: '#d0a975', 'font-size': 11 },
        sequence.reasons.length ? sequence.reasons.join(' · ').slice(0, 240) :
          sequence.reachedExit ? 'Recorded exit for this bounded variant.' :
            'Open boundary; no return beyond the recorded events.'));
    }
    function render() {
      compare.replaceChildren(); select.replaceChildren();
      var comparing = mode === 'flamegraph' && flameLayout === 'order';
      compare.style.display = comparing ? 'grid' : 'none';
      stage.classList.toggle('flamegraph-mode', mode === 'flamegraph');
      stage.classList.toggle('call-order-mode', mode === 'flamegraph' && flameLayout === 'order');
      hoverStatus.style.display = mode === 'flamegraph' ? '' : 'none';
      plotCounts.style.display = mode === 'flamegraph' ? '' : 'none';
      sequenceButton.disabled = mode === 'sequence'; flameButton.disabled = mode === 'flamegraph';
      orderButton.style.display = mergedButton.style.display = mode === 'flamegraph' ? '' : 'none';
      orderButton.disabled = flameLayout === 'order'; mergedButton.disabled = flameLayout === 'merged';
      backButton.style.display = mode === 'flamegraph' && zoomId ? '' : 'none';
      resetZoomButton.style.display = mode === 'flamegraph' ? '' : 'none';
      resetZoomButton.disabled = !zoomId;
      zoomLabel.style.display = mode === 'flamegraph' ? '' : 'none';
      var heading = head.querySelector('strong'), description = head.querySelector('.muted');
      heading.textContent = mode === 'flamegraph' ? 'Request flow · Flamegraph' :
        'Request flow · UML sequence';
      description.textContent = mode === 'flamegraph' ?
        'Call order shows each invocation in one selected bounded variant; Merged stacks combines returned examples. Width counts compiled events, not time. Select a frame to zoom, inspect source, pin, or expand its captured execution flow.' :
        'Lifelines, distinct activations, calls, and recorded returns for one selected bounded path. Vertical order counts MIR events, not elapsed time. Choose a variant to inspect another path.';
      if (result && result.orderedEvidence) {
        heading.textContent = 'STRUCTURAL ordered witness · ' + (mode === 'sequence' ? 'UML sequence' : 'Flamegraph');
        description.textContent = 'These events project the selected ordered proof, including its exact callsites and continuations. The proof/replay disclosure retains source and summary identities. Event positions are not runtime timing.';
      }
      var shown = flameLayout === 'order' ? variants[selected] ? [variants[selected]] : [] : variants;
      var bars = shown.reduce(function (all, variant) { return all.concat(variant.bars); }, []);
      var boundaries = bars.filter(function (bar) { return bar.synthetic || bar.outcome.indexOf('unavailable') >= 0; }).length;
      var open = bars.filter(function (bar) { return bar.outcome === 'open / truncated boundary'; }).length;
      var unique = new Set(bars.filter(function (bar) { return !bar.synthetic; }).map(function (bar) { return bar.function; })).size;
      var depth = bars.reduce(function (max, bar) { return Math.max(max, bar.depth + 1); }, 0);
      var totalCalls = variants.reduce(function (sum, variant) {
        return sum + variant.bars.filter(function (bar) { return bar.via !== 'entry'; }).length;
      }, 0);
      plotCounts.textContent = (comparing ? variants.length + ' returned bounded variants · ' +
        totalCalls + ' call frames summed across variants (callsite repeats possible) · ' : '') +
        (result && result.orderedEvidence ? 'Ordered proof root: ' : 'Bounded witness root: ') + entry.value +
        (focused && entry.value === focused ? ' (selected function)' : ' (compiled entry)') + ' · ' +
        bars.length + ' recorded activation/callsite frames · ' +
        (bars.length - boundaries) + ' known-body frames · ' + boundaries +
        ' opaque/unknown boundaries · ' + unique + ' unique captured functions · max displayed stack depth ' + depth +
        (open ? ' · ' + open + ' open at bound' : '') +
        (result && result.limits && !result.orderedEvidence ? ' · search budget ' + result.limits.maxPaths +
          ' paths / ' + result.limits.maxSteps + ' steps / depth ' + result.limits.maxDepth : '') +
        (result && result.truncated ? ' · SEARCH CAP: more variants may exist' : '') +
        (shown.some(function (variant) { return !variant.reachedExit; }) ?
          ' · continuation beyond recorded bound omitted' : '');
      if (!variants.length) {
        compare.textContent = 'No bounded example contains every selected pin from this entry. The full statechart still retains all recorded branches.';
        if (mode === 'flamegraph') renderFlame();
        else renderSequence(null);
        return;
      }
      if (comparing) {
        var sharedSteps = Math.max(1, variants.reduce(function (max, variant) {
          return Math.max(max, variant.steps);
        }, 0));
        variants.forEach(function (variant, i) { compare.appendChild(mini(variant, i, sharedSteps)); });
      }
      variants.forEach(function (variant, i) {
        var option = doc.createElement('option'); option.value = i;
        option.textContent = 'Variant ' + (i + 1) + ' · ' + variant.steps + ' steps · ' +
          (variant.reachedExit ? 'recorded exit' : 'boundary/bound'); select.appendChild(option);
      });
      select.value = String(selected);
      if (mode === 'flamegraph') renderFlame(); else renderSequence(sequences[selected]);
    }
    function setMode(next) {
      if (next !== 'sequence' && next !== 'flamegraph') return;
      mode = next; render();
    }
    function setResult(next) {
      result = next; variants = (next.traces || []).map(project);
      selected = richestVariantIndex(variants);
      ordered = variants.map(orderedFrames);
      sequences = (next.traces || []).map(function (trace, i) { return sequenceProject(trace, variants[i]); });
      flame = aggregate(variants); zoomId = 0;
      var cap = next.truncated ? ' · SEARCH CAP REACHED; additional variants may exist' : '';
      status.textContent = variants.length + ' bounded compiler path example' + (variants.length === 1 ? '' : 's') +
        ' · ' + next.exploredStates + ' states explored · ' +
        (next.limits.includeUnwind ? 'normal + panic/unwind scope' : 'normal successor scope') + cap +
        ' · source bodies unavailable: ' + (next.coverage && next.coverage.unavailableCount || 0);
      notes.replaceChildren(); (next.diagnostics || []).forEach(function (message) {
        var row = doc.createElement('div'); row.textContent = message; notes.appendChild(row);
      });
      render();
    }
    function clearWitness() {
      if (!result || !result.orderedEvidence) return;
      result = null; variants = []; sequences = []; ordered = []; selected = 0;
      flame = aggregate([]); zoomId = 0;
      compare.replaceChildren(); select.replaceChildren(); detail.replaceChildren(); notes.replaceChildren(); sourceInfo(null);
      status.textContent = 'Ordered witness cleared; choose an entry or run another query.';
    }
    function openWitness(next, nextMode) {
      if (!next || !next.orderedEvidence || !next.traces || next.traces.length !== 1) return;
      focused = next.orderedEvidence.resolved.root.id;
      flameLayout = 'order'; zoomId = 0; selected = 0;
      if (!Array.from(entry.options).some(function (option) { return option.value === focused; })) {
        var option = doc.createElement('option'); option.value = focused;
        option.textContent = focused + ' · ordered structural witness'; entry.appendChild(option);
      }
      entry.value = focused;
      hooks.activate(); setResult(next); setMode(nextMode || 'flamegraph');
      status.textContent = 'STRUCTURAL ordered witness · ' + next.orderedEvidence.witness.rootProofId +
        (next.truncated ? ' · evidence truncated' : '') + ' · event positions, not runtime timing';
      var disclosure = doc.createElement('details'), summary = doc.createElement('summary');
      summary.textContent = 'Exact ordered proof, source and replay'; disclosure.appendChild(summary);
      var text = doc.createElement('pre'); text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere';
      text.textContent = JSON.stringify(next.orderedEvidence, null, 2); disclosure.appendChild(text); notes.appendChild(disclosure);
    }
    sequenceButton.onclick = function () { setMode('sequence'); };
    flameButton.onclick = function () { setMode('flamegraph'); };
    orderButton.onclick = function () { flameLayout = 'order'; zoomId = 0; render(); };
    mergedButton.onclick = function () { flameLayout = 'merged'; zoomId = 0; render(); };
    macroButton.onclick = function () { hooks.back(); };
    backButton.onclick = function () {
      var node = findFrame(zoomId);
      zoomId = node && node.parentId != null ? node.parentId : 0;
      renderFlame();
    };
    resetZoomButton.onclick = function () { zoomId = 0; renderFlame(); };
    if (typeof ResizeObserver === 'function') new ResizeObserver(function () {
      var width = Math.max(320, detail.parentElement.clientWidth || stage.clientWidth || 980,
        flameLayout === 'order' ? currentFlame().weight * 12 + 16 : 0);
      if (active && mode === 'flamegraph' && width !== lastFlameWidth) renderFlame(true);
    }).observe(detail.parentElement);
    entry.onchange = ask; panic.onchange = ask;
    select.onchange = function () { selected = Number(select.value) || 0; zoomId = 0; render(); };
    doc.getElementById('waterfall-reset').onclick = function () {
      focused = null; setCatalog({ roots: { application: roots } }, true);
      if (roots.length) entry.value = roots[0]; ask();
    };
    pinText();
    return { setCatalog: setCatalog, open: open, openWitness: openWitness, clearWitness: clearWitness, setMode: setMode,
      hasWitness: function () { return !!(result && result.orderedEvidence); },
      setPins: setPins, setResult: setResult,
      activate: activate, request: ask, stats: function () { return { active: active, root: entry.value,
        pins: pins.slice(), variants: variants.length, selected: selected, mode: mode,
        flamePath: flamePath(), flameLayout: flameLayout,
        steps: variants[selected] && variants[selected].steps,
        markers: variants[selected] && variants[selected].counts, truncated: result && result.truncated }; } };
  }

  return { project: project, aggregate: aggregate, orderedFrames: orderedFrames,
    richestVariantIndex: richestVariantIndex, frameAt: frameAt,
    sequenceProject: sequenceProject, mount: mount };
});
