/**
 * The region in 3D (§32–49): terrain, seven districts, every plant, every line, weather, day and night, traffic,
 * fuel trucks, ships and smoke, all driven by the live view. Static geometry is built once and instanced; anything
 * that moves reads the latest view from a ref inside useFrame, so a new view every second never rebuilds the scene.
 */
import { CameraControls, Html } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ElementRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import type { CorridorView, NodeId, NodeView, PlantView, RegionView, TechId, TownView } from '@blackout/shared'
import { ITEMS } from '@blackout/shared'
import { mw, price } from '../format'
import { ACTOR_SPOT, DISTRICT, buildPads, districtBuildings, lineRoute, plantPad, rng, type Vec2 } from './layout'

export type Selection = { kind: 'plant' | 'node' | 'corridor' | 'actor' | 'merchant'; id: string }
export type ZoomLevel = 'REGION' | 'LOAD CENTER' | 'DISTRICT' | 'BUSINESS'
export interface FocusCmd {
  kind: 'node' | 'plant' | 'actor' | 'corridor' | 'merchant' | 'home'
  id: string
  nonce: number
  /** Camera distance override. */
  dist?: number
}

export interface WorldProps {
  view: RegionView
  viewRef: MutableRefObject<RegionView>
  selection: Selection | null
  onSelect: (s: Selection | null) => void
  overlay: 'normal' | 'grid'
  building: { tech: TechId; size: number } | null
  onBuildAt: (nodeId: NodeId) => void
  focus: FocusCmd | null
  highlight: string | null
  quality: 'high' | 'low'
  onZoom: (z: ZoomLevel) => void
  /** First minute: one big in-world button on the thing to tap. */
  mission: { target: string; label: string } | null
  onMission: () => void
  /** First minute: hide everything that isn't the task. */
  simple: boolean
  /** Vesper Market, shared by every player. */
  town: TownView | null
  zoom: ZoomLevel
}

const C = {
  teal: new THREE.Color('#2dd4bf'),
  amber: new THREE.Color('#f5a524'),
  red: new THREE.Color('#ef4444'),
  blue: new THREE.Color('#60a5fa'),
  gold: new THREE.Color('#fbbf24'),
  violet: new THREE.Color('#a78bfa'),
  white: new THREE.Color('#ffffff'),
  warm: new THREE.Color('#ffd28a'),
}

export function World3D(p: WorldProps) {
  return (
    <Canvas
      shadows={p.quality === 'high'}
      dpr={p.quality === 'high' ? [1, 1.75] : [1, 1.2]}
      camera={{ position: [0, 175, 205], fov: 40, near: 1, far: 2400 }}
      gl={{ antialias: p.quality === 'high', powerPreference: 'high-performance' }}
      onPointerMissed={(e) => {
        // HTML chips sit inside the canvas wrapper: only a click on the 3D canvas itself clears the selection
        if ((e.target as HTMLElement | null)?.tagName === 'CANVAS') p.onSelect(null)
      }}
      aria-label="The Vesper region in 3D"
    >
      <Scene {...p} />
    </Canvas>
  )
}

function Scene(p: WorldProps) {
  const { view, viewRef } = p
  const nodes = view.nodes
  const nodePos = useMemo(() => Object.fromEntries(nodes.map((n) => [n.nodeId, [n.x, n.z] as Vec2])), [nodes.map((n) => n.nodeId).join()]) as Record<NodeId, Vec2>
  const plantPads = useMemo(() => {
    const byNode: Record<string, PlantView[]> = {}
    for (const pl of [...view.plants].sort((a, b) => a.assetNo - b.assetNo)) (byNode[pl.nodeId] ??= []).push(pl)
    const pads: Record<string, Vec2> = {}
    for (const [nodeId, list] of Object.entries(byNode)) list.forEach((pl, i) => (pads[pl.plantId] = plantPad(nodePos[nodeId as NodeId][0], nodePos[nodeId as NodeId][1], nodeId as NodeId, i)))
    return { pads, used: Object.fromEntries(Object.entries(byNode).map(([k, v]) => [k, v.length])) as Record<string, number> }
  }, [view.plants.map((x) => x.plantId).join(), nodePos])
  const routes = useMemo(() => Object.fromEntries(view.corridors.map((c) => [c.corridorId, lineRoute(nodePos[c.from], nodePos[c.to], c.corridorId)])), [view.corridors.length, nodePos])
  const lowQ = p.quality === 'low'

  return (
    <>
      <SkyAndLight viewRef={viewRef} lowQ={lowQ} />
      <Ground nodes={nodes} />
      <Water />
      {nodes.map((n) => (
        <District key={n.nodeId} node={n} viewRef={viewRef} onSelect={p.onSelect} building={!!p.building} onBuildAt={p.onBuildAt} />
      ))}
      {view.actors.map((a) => {
        const np = nodePos[a.nodeId]
        const spot = ACTOR_SPOT[a.actorId] ?? { dx: 0, dz: 0 }
        return <Landmark key={a.actorId} actorId={a.actorId} kind={a.kind} x={np[0] + spot.dx} z={np[1] + spot.dz} viewRef={viewRef} selected={p.selection?.kind === 'actor' && p.selection.id === a.actorId} onSelect={p.onSelect} />
      })}
      {view.plants.map((pl) => (
        <Plant key={pl.plantId} plant={pl} pos={plantPads.pads[pl.plantId]} viewRef={viewRef} selected={p.selection?.kind === 'plant' && p.selection.id === pl.plantId} highlight={p.highlight === `plant:${pl.plantId}`} onSelect={p.onSelect} />
      ))}
      {view.corridors.map((c) => (
        <PowerLine key={c.corridorId} c={c} route={routes[c.corridorId]} overlay={p.overlay} selected={p.selection?.kind === 'corridor' && p.selection.id === c.corridorId} highlight={p.highlight === `corridor:${c.corridorId}`} onSelect={p.onSelect} />
      ))}
      <FlowDots viewRef={viewRef} routes={routes} />
      <Smoke viewRef={viewRef} pads={plantPads.pads} nodePos={nodePos} lowQ={lowQ} />
      <Traffic viewRef={viewRef} routes={routes} lowQ={lowQ} />
      <Ships viewRef={viewRef} />
      <Weather viewRef={viewRef} lowQ={lowQ} />
      {p.building && !p.simple && nodes.map((n) => <BuildPads key={n.nodeId} node={n} used={plantPads.used[n.nodeId] ?? 0} onBuildAt={p.onBuildAt} />)}
      {nodes.filter((n) => !p.simple || n.shedKw > 0 || p.highlight === `node:${n.nodeId}`).map((n) => (
        <NodeChip key={n.nodeId} node={n} overlay={p.overlay} selected={p.selection?.kind === 'node' && p.selection.id === n.nodeId} highlight={p.highlight === `node:${n.nodeId}`} onSelect={p.onSelect} />
      ))}
      {p.mission && <MissionButton mission={p.mission} onMission={p.onMission} nodePos={nodePos} pads={plantPads.pads} used={plantPads.used} view={view} />}
      {p.overlay === 'grid' && view.corridors.map((c) => <LineChip key={c.corridorId} c={c} route={routes[c.corridorId]} onSelect={p.onSelect} />)}
      {view.plants.filter((pl) => (pl.mine && !(p.simple && p.mission?.target === `plant:${pl.plantId}`)) || (p.selection?.kind === 'plant' && p.selection.id === pl.plantId)).map((pl) => (
        <PlantChip key={pl.plantId} plant={pl} pos={plantPads.pads[pl.plantId]} onSelect={p.onSelect} />
      ))}
      {p.town && <MarketStreet town={p.town} simple={p.simple} far={p.zoom === 'REGION'} selected={p.selection?.kind === 'merchant' ? p.selection.id : null} onSelect={p.onSelect} />}
      <Controls focus={p.focus} nodePos={nodePos} pads={plantPads.pads} routes={routes} onZoom={p.onZoom} view={view} />
    </>
  )
}

/* ------------------------------------------------------------------------------------------- sky & light */

function SkyAndLight({ viewRef, lowQ }: { viewRef: MutableRefObject<RegionView>; lowQ: boolean }) {
  const sun = useRef<THREE.DirectionalLight>(null)
  const hemi = useRef<THREE.HemisphereLight>(null)
  const { scene } = useThree()
  const flash = useRef(0)
  const bg = useMemo(() => new THREE.Color('#0b1020'), [])
  useEffect(() => {
    scene.background = bg
    scene.fog = new THREE.Fog(bg.getHex(), 260, 900)
  }, [scene, bg])
  useFrame((_, dt) => {
    const v = viewRef.current
    const m = v.clock.minuteOfDay
    const elev = v.clock.sunElevation
    const cloud = v.weather.cloudPct / 100
    const storm = v.weather.condition === 'storm'
    const heat = v.weather.condition === 'heatwave'
    const t = ((m - 360) / 810) * Math.PI
    const dayCol = new THREE.Color(heat ? '#e9c48f' : '#8fbde3').lerp(new THREE.Color('#8a94a3'), cloud * 0.7)
    const duskCol = new THREE.Color('#e6864d')
    const nightCol = new THREE.Color('#070b16')
    const target = elev <= 0 ? nightCol : elev < 0.18 ? nightCol.clone().lerp(duskCol, elev / 0.18).lerp(dayCol, Math.max(0, (elev - 0.1) / 0.08)) : dayCol
    if (storm) target.lerp(new THREE.Color('#2b3240'), 0.6)
    bg.lerp(target, Math.min(1, dt * 1.5))
    if (scene.background !== bg) scene.background = bg
    if (!(scene.fog instanceof THREE.Fog)) scene.fog = new THREE.Fog(bg.getHex(), 260, 900)
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.copy(bg)
      scene.fog.near = heat ? 140 : 200; scene.fog.far = 760
    }
    if (sun.current) {
      sun.current.position.set(Math.cos(t) * 300, Math.max(15, Math.sin(t) * 320), -120)
      sun.current.intensity = THREE.MathUtils.lerp(sun.current.intensity, elev > 0 ? 0.4 + elev * 2.4 * (1 - cloud * 0.55) : 0.12, Math.min(1, dt * 2))
      sun.current.color.set(elev < 0.2 && elev > 0 ? '#ffb27a' : elev <= 0 ? '#7f9cff' : '#fff4e0')
    }
    // storms throw lightning
    if (storm && Math.random() < dt * 0.25) flash.current = 1
    flash.current = Math.max(0, flash.current - dt * 4)
    if (hemi.current) hemi.current.intensity = 0.35 + elev * 0.55 + flash.current * 2.5
  })
  return (
    <>
      <hemisphereLight ref={hemi} args={['#c8d8ff', '#283018', 0.6]} />
      <directionalLight ref={sun} castShadow={!lowQ} intensity={1.2} position={[200, 260, -120]} shadow-mapSize={[1024, 1024]} shadow-camera-left={-220} shadow-camera-right={220} shadow-camera-top={220} shadow-camera-bottom={-220} />
    </>
  )
}

/* ---------------------------------------------------------------------------------------------- ground */

function Ground({ nodes }: { nodes: NodeView[] }) {
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow position={[0, -0.05, 0]}>
        <planeGeometry args={[900, 700]} />
        <meshStandardMaterial color="#4b5a3c" roughness={1} />
      </mesh>
      {nodes.map((n) => (
        <mesh key={n.nodeId} rotation-x={-Math.PI / 2} position={[n.x, 0.02, n.z]} receiveShadow>
          <circleGeometry args={[DISTRICT[n.nodeId].radius + 6, 48]} />
          <meshStandardMaterial color={DISTRICT[n.nodeId].ground} roughness={0.95} />
        </mesh>
      ))}
      <Fields />
    </group>
  )
}

function Fields() {
  const geo = useMemo(() => new THREE.PlaneGeometry(1, 1), [])
  const ref = useRef<THREE.InstancedMesh>(null)
  const items = useMemo(() => {
    const r = rng('fields')
    const out: { x: number; z: number; w: number; d: number; c: THREE.Color }[] = []
    for (let i = 0; i < 46; i++) out.push({ x: -70 + r() * 140, z: -125 + r() * 52, w: 8 + r() * 14, d: 6 + r() * 10, c: new THREE.Color().setHSL(0.17 + r() * 0.1, 0.35, 0.28 + r() * 0.12) })
    return out
  }, [])
  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    items.forEach((f, i) => {
      m.compose(new THREE.Vector3(f.x, 0.03, f.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), new THREE.Vector3(f.w, f.d, 1))
      ref.current!.setMatrixAt(i, m)
      ref.current!.setColorAt(i, f.c)
    })
    ref.current!.instanceMatrix.needsUpdate = true
    if (ref.current!.instanceColor) ref.current!.instanceColor.needsUpdate = true
  }, [items])
  return (
    <instancedMesh ref={ref} args={[geo, undefined, items.length]} receiveShadow>
      <meshStandardMaterial roughness={1} />
    </instancedMesh>
  )
}

function Water() {
  const ref = useRef<THREE.MeshStandardMaterial>(null)
  useFrame(({ clock }) => {
    if (ref.current) ref.current.color.setHSL(0.58, 0.45, 0.24 + Math.sin(clock.elapsedTime * 0.6) * 0.012)
  })
  return (
    <mesh rotation-x={-Math.PI / 2} position={[-150, 0.04, 120]} receiveShadow>
      <planeGeometry args={[180, 140]} />
      <meshStandardMaterial ref={ref} color="#21455f" roughness={0.25} metalness={0.3} />
    </mesh>
  )
}

/* -------------------------------------------------------------------------------------------- districts */

function windowTexture(seed: string, warm: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, 32, 64)
  const r = rng(seed)
  for (let y = 2; y < 62; y += 5) for (let x = 2; x < 30; x += 5) if (r() < 0.62) {
    g.fillStyle = warm ? `hsl(${38 + r() * 12}, 90%, ${55 + r() * 25}%)` : `hsl(${190 + r() * 20}, 70%, ${60 + r() * 20}%)`
    g.fillRect(x, y, 3, 3)
  }
  const t = new THREE.CanvasTexture(c)
  t.magFilter = THREE.NearestFilter
  return t
}

/** Per-node light level with the blackout sequence: lights flicker, then die; restoring ramps them back. */
function useDistrictLights(nodeId: NodeId, viewRef: MutableRefObject<RegionView>, mats: THREE.MeshStandardMaterial[]) {
  const state = useRef({ dark: false, since: 0, level: 1 })
  useFrame(({ clock }, dt) => {
    const v = viewRef.current
    const n = v.nodes.find((x) => x.nodeId === nodeId)
    if (!n) return
    const now = clock.elapsedTime
    if (n.dark !== state.current.dark) {
      state.current.dark = n.dark
      state.current.since = now
    }
    const night = v.clock.isNight ? 1 : v.clock.sunElevation < 0.15 ? 0.55 : 0.06
    let target = state.current.dark ? 0 : night
    if (state.current.dark && now - state.current.since < 1.6) target = Math.random() < 0.5 ? night : 0.02
    state.current.level = state.current.dark && now - state.current.since < 1.6 ? target : THREE.MathUtils.lerp(state.current.level, target, Math.min(1, dt * 1.8))
    for (const m of mats) {
      m.emissiveIntensity = state.current.level * 1.4
      // in daylight a blackout still shows: the district goes grey and lifeless
      const base = (m.userData.base as THREE.Color | undefined) ?? (m.userData.base = m.color.clone())
      m.color.lerp(state.current.dark ? new THREE.Color('#3a3d44') : base, Math.min(1, dt * 3))
    }
  })
}

const District = memo(function District({ node, viewRef, onSelect, building, onBuildAt }: { node: NodeView; viewRef: MutableRefObject<RegionView>; onSelect: WorldProps['onSelect']; building: boolean; onBuildAt: (n: NodeId) => void }) {
  const st = DISTRICT[node.nodeId]
  const items = useMemo(() => districtBuildings(node.nodeId, node.x, node.z), [node.nodeId, node.x, node.z])
  const box = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), [])
  const roof = useMemo(() => new THREE.ConeGeometry(0.78, 0.9, 4).rotateY(Math.PI / 4).translate(0, 0.45, 0), [])
  const tex = useMemo(() => windowTexture(node.nodeId, st.kind !== 'campus'), [node.nodeId, st.kind])
  const facade = useMemo(
    () => new THREE.MeshStandardMaterial({ color: st.kind === 'towers' ? '#8b93a3' : st.kind === 'campus' ? '#7fb2c0' : st.kind === 'industry' ? '#8a7a68' : st.kind === 'port' ? '#ffffff' : st.kind === 'hospital' ? '#e4e8ee' : '#d8cdb8', roughness: st.kind === 'campus' ? 0.2 : 0.8, metalness: st.kind === 'campus' ? 0.4 : 0.05, emissive: new THREE.Color('#ffffff'), emissiveMap: st.kind === 'port' ? null : tex, emissiveIntensity: 0 }),
    [st.kind, tex],
  )
  const roofMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8c3b2e', roughness: 0.9 }), [])
  const ref = useRef<THREE.InstancedMesh>(null)
  const roofRef = useRef<THREE.InstancedMesh>(null)
  useDistrictLights(node.nodeId, viewRef, [facade])
  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const col = new THREE.Color()
    items.forEach((b, i) => {
      q.setFromEuler(new THREE.Euler(0, b.rot, 0))
      m.compose(new THREE.Vector3(b.x, 0, b.z), q, new THREE.Vector3(b.w, b.h, b.d))
      ref.current!.setMatrixAt(i, m)
      if (st.kind === 'port') col.setHSL([0.0, 0.08, 0.55, 0.6, 0.33][Math.floor(b.tint * 5)], 0.6, 0.45)
      else col.setHSL(0, 0, 0.75 + b.tint * 0.25)
      ref.current!.setColorAt(i, col)
      if (roofRef.current) {
        m.compose(new THREE.Vector3(b.x, b.h, b.z), q, new THREE.Vector3(b.w * 1.05, 1, b.d * 1.05))
        roofRef.current.setMatrixAt(i, m)
      }
    })
    ref.current!.instanceMatrix.needsUpdate = true
    if (ref.current!.instanceColor) ref.current!.instanceColor.needsUpdate = true
    if (roofRef.current) roofRef.current.instanceMatrix.needsUpdate = true
  }, [items, st.kind])
  return (
    <group
      onClick={(e) => {
        e.stopPropagation()
        if (building) onBuildAt(node.nodeId)
        else onSelect({ kind: 'node', id: node.nodeId })
      }}
    >
      <instancedMesh ref={ref} args={[box, facade, items.length]} castShadow receiveShadow />
      {st.kind === 'houses' && <instancedMesh ref={roofRef} args={[roof, roofMat, items.length]} castShadow />}
      {st.kind === 'industry' && <Chimneys node={node} />}
      {st.kind === 'port' && <Cranes node={node} viewRef={viewRef} />}
      {/* streetlights glow at night, die in a blackout */}
      <StreetGlow node={node} viewRef={viewRef} />
    </group>
  )
})

function StreetGlow({ node, viewRef }: { node: NodeView; viewRef: MutableRefObject<RegionView> }) {
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffcf87', transparent: true, opacity: 0, depthWrite: false }), [])
  const pulse = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ef4444', transparent: true, opacity: 0, depthWrite: false }), [])
  const ring = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    const v = viewRef.current
    const n = v.nodes.find((x) => x.nodeId === node.nodeId)!
    mat.opacity = n.dark ? 0 : v.clock.isNight ? 0.14 : 0
    pulse.opacity = n.shedKw > 0 ? 0.25 + Math.sin(clock.elapsedTime * 4) * 0.15 : 0
    if (ring.current) ring.current.scale.setScalar(1 + ((clock.elapsedTime * 0.5) % 1) * 0.3)
  })
  const r = DISTRICT[node.nodeId].radius + 6
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position={[node.x, 0.06, node.z]} material={mat}>
        <circleGeometry args={[r, 48]} />
      </mesh>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position={[node.x, 0.08, node.z]} material={pulse}>
        <ringGeometry args={[r - 1.2, r, 64]} />
      </mesh>
    </>
  )
}

function Chimneys({ node }: { node: NodeView }) {
  const spots = useMemo(() => {
    const r = rng(`chim:${node.nodeId}`)
    return Array.from({ length: 6 }, () => [node.x + (r() - 0.5) * 30, node.z + (r() - 0.5) * 30] as Vec2)
  }, [node.nodeId, node.x, node.z])
  return (
    <>
      {spots.map(([x, z], i) => (
        <mesh key={i} position={[x, 6, z]} castShadow>
          <cylinderGeometry args={[0.6, 0.9, 12, 10]} />
          <meshStandardMaterial color="#6b625a" roughness={0.9} />
        </mesh>
      ))}
    </>
  )
}

function Cranes({ node, viewRef }: { node: NodeView; viewRef: MutableRefObject<RegionView> }) {
  const arms = useRef<THREE.Group[]>([])
  useFrame(({ clock }) => {
    const port = viewRef.current.actors.find((a) => a.actorId === 'port')
    const busy = port ? port.productionBps / 10_000 : 0
    arms.current.forEach((g, i) => g && (g.rotation.y = Math.sin(clock.elapsedTime * 0.4 * busy + i) * 0.9 * busy))
  })
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <group key={i} position={[node.x - 24 - i * 7, 0, node.z + 14 + (i % 2) * 6]}>
          <mesh position={[0, 7, 0]} castShadow>
            <boxGeometry args={[0.8, 14, 0.8]} />
            <meshStandardMaterial color="#e25d33" />
          </mesh>
          <group position={[0, 14, 0]} ref={(g) => (arms.current[i] = g!)}>
            <mesh position={[4, 0, 0]} castShadow>
              <boxGeometry args={[11, 0.6, 0.6]} />
              <meshStandardMaterial color="#e25d33" />
            </mesh>
          </group>
        </group>
      ))}
    </>
  )
}

/* ------------------------------------------------------------------------------------------- landmarks */

function Landmark({ actorId, kind, x, z, viewRef, selected, onSelect }: { actorId: string; kind: string; x: number; z: number; viewRef: MutableRefObject<RegionView>; selected: boolean; onSelect: WorldProps['onSelect'] }) {
  const mat = useRef<THREE.MeshStandardMaterial>(null)
  const nodeId = useMemo(() => viewRef.current.actors.find((a) => a.actorId === actorId)!.nodeId, [actorId, viewRef])
  const lit = useRef(1)
  useFrame(({ clock }, dt) => {
    const v = viewRef.current
    const a = v.actors.find((x) => x.actorId === actorId)
    const n = v.nodes.find((x) => x.nodeId === nodeId)
    if (!a || !n || !mat.current) return
    const on = a.state !== 'closed' && a.servedKw > a.demandKw * 0.5
    const target = on ? (v.clock.isNight ? 1 : 0.15) : 0
    lit.current = THREE.MathUtils.lerp(lit.current, target, Math.min(1, dt * 2))
    mat.current.emissiveIntensity = lit.current * (selected ? 1.6 + Math.sin(clock.elapsedTime * 5) * 0.4 : 1.1)
    mat.current.color.set(a.state === 'closed' ? '#555b63' : a.state === 'distressed' ? '#b68a6a' : '#c8ced8')
  })
  const dims: Record<string, [number, number, number]> = { industry: [12, 7, 9], port: [10, 5, 8], datacenter: [12, 6, 10], commerce: [6, 34, 6], hospital: [12, 9, 10], households: [6, 4, 6], farms: [8, 3, 6] }
  const [w, h, d] = dims[kind] ?? [6, 6, 6]
  return (
    <group
      position={[x, 0, z]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect({ kind: 'actor', id: actorId })
      }}
    >
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial ref={mat} color="#c8ced8" roughness={0.6} emissive={kind === 'hospital' ? '#bfe3ff' : '#ffd28a'} emissiveIntensity={0.3} />
      </mesh>
      {kind === 'hospital' && (
        <group position={[0, h + 0.3, 0]}>
          <mesh>
            <boxGeometry args={[5, 0.4, 1.4]} />
            <meshBasicMaterial color="#ef4444" />
          </mesh>
          <mesh>
            <boxGeometry args={[1.4, 0.4, 5]} />
            <meshBasicMaterial color="#ef4444" />
          </mesh>
        </group>
      )}
      {kind === 'datacenter' && [-3, 0, 3].map((dx) => (
        <mesh key={dx} position={[dx, h + 0.8, 0]}>
          <cylinderGeometry args={[1.1, 1.1, 1.4, 12]} />
          <meshStandardMaterial color="#9aa4b1" metalness={0.6} roughness={0.3} />
        </mesh>
      ))}
      {selected && <SelectRing r={Math.max(w, d) * 0.85} />}
    </group>
  )
}

function SelectRing({ r, color = '#ffffff' }: { r: number; color?: string }) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => ref.current && (ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 4) * 0.06)))
  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2} position={[0, 0.15, 0]}>
      <ringGeometry args={[r, r + 0.8, 48]} />
      <meshBasicMaterial color={color} transparent opacity={0.9} />
    </mesh>
  )
}

function Beacon({ y }: { y: number }) {
  const ref = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    ref.current.position.y = y + Math.sin(clock.elapsedTime * 3) * 1.2
    ref.current.rotation.y = clock.elapsedTime * 2
  })
  return (
    <group ref={ref}>
      <mesh rotation-x={Math.PI}>
        <coneGeometry args={[1.6, 3.4, 4]} />
        <meshBasicMaterial color="#fbbf24" />
      </mesh>
    </group>
  )
}

/* ---------------------------------------------------------------------------------------------- plants */

const Plant = memo(function Plant({ plant, pos, viewRef, selected, highlight, onSelect }: { plant: PlantView; pos: Vec2; viewRef: MutableRefObject<RegionView>; selected: boolean; highlight: boolean; onSelect: WorldProps['onSelect'] }) {
  const glow = useRef<THREE.MeshStandardMaterial>(null)
  const alarm = useRef<THREE.MeshBasicMaterial>(null)
  const scaffold = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    const pl = viewRef.current.plants.find((x) => x.plantId === plant.plantId)
    if (!pl) return
    const load = pl.capacityKw > 0 ? Math.abs(pl.netKw) / pl.capacityKw : 0
    if (glow.current) {
      glow.current.emissiveIntensity = pl.status === 'online' ? 0.25 + load * 1.4 : pl.status === 'starting' ? 0.5 + Math.sin(clock.elapsedTime * 6) * 0.4 : 0
      glow.current.emissive.set(pl.tech === 'battery' ? (pl.netKw < 0 ? '#60a5fa' : '#2dd4bf') : pl.tech === 'solar' ? '#7dd3fc' : '#ffb347')
    }
    if (alarm.current) alarm.current.opacity = pl.status === 'tripped' ? (Math.sin(clock.elapsedTime * 8) > 0 ? 0.95 : 0.15) : 0
    if (scaffold.current) scaffold.current.scale.y = pl.status === 'building' ? Math.max(0.05, 1 - pl.buildRemaining / Math.max(1, pl.buildTotal)) : 0.0001
  })
  const owner = plant.mine ? C.gold : plant.ownerId === 'voltline' ? C.violet : C.blue
  const scale = Math.min(1.6, 0.6 + Math.sqrt(plant.capacityKw / 120_000) * 0.6)
  const gray = plant.status === 'mothballed'
  const body = gray ? '#5d6168' : '#b9c0c9'
  return (
    <group
      position={[pos[0], 0, pos[1]]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect({ kind: 'plant', id: plant.plantId })
      }}
    >
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.1, 0]} receiveShadow>
        <circleGeometry args={[7 * scale + 2, 32]} />
        <meshStandardMaterial color="#3a3f46" roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.12, 0]}>
        <ringGeometry args={[7 * scale + 1.4, 7 * scale + 2, 40]} />
        <meshBasicMaterial color={owner} transparent opacity={plant.mine ? 0.95 : 0.55} />
      </mesh>
      {plant.status === 'building' ? (
        <mesh ref={scaffold} position={[0, 0, 0]}>
          <boxGeometry args={[9 * scale, 8, 7 * scale]} />
          <meshBasicMaterial color="#f5a524" wireframe />
        </mesh>
      ) : (
        <PlantModel tech={plant.tech} scale={scale} body={body} glowRef={glow} />
      )}
      <mesh position={[0, 15 * scale, 0]}>
        <sphereGeometry args={[0.9, 10, 10]} />
        <meshBasicMaterial ref={alarm} color="#ef4444" transparent opacity={0} />
      </mesh>
      {selected && <SelectRing r={7 * scale + 2.6} />}
      {highlight && <Beacon y={18 * scale} />}
    </group>
  )
})

function PlantModel({ tech, scale, body, glowRef }: { tech: TechId; scale: number; body: string; glowRef: MutableRefObject<THREE.MeshStandardMaterial | null> }) {
  const s = scale
  if (tech === 'solar') {
    const panels: Vec2[] = []
    for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) panels.push([(i - 2) * 2.6 * s, (j - 1.5) * 2.4 * s])
    return (
      <group>
        {panels.map(([x, z], i) => (
          <mesh key={i} position={[x, 1, z]} rotation-x={-0.6} castShadow>
            <boxGeometry args={[2.3 * s, 0.12, 1.6 * s]} />
            <meshStandardMaterial ref={i === 0 ? glowRef : undefined} color="#1d3557" metalness={0.6} roughness={0.25} emissive="#7dd3fc" emissiveIntensity={0} />
          </mesh>
        ))}
      </group>
    )
  }
  if (tech === 'battery') {
    return (
      <group>
        {[-1, 0, 1].map((r) =>
          [-1.5, -0.5, 0.5, 1.5].map((c) => (
            <mesh key={`${r}${c}`} position={[c * 3.2 * s, 1.2, r * 3 * s]} castShadow>
              <boxGeometry args={[2.8 * s, 2.4, 2.2 * s]} />
              <meshStandardMaterial ref={r === 0 && c === -0.5 ? glowRef : undefined} color="#eef2f6" roughness={0.5} emissive="#2dd4bf" emissiveIntensity={0} />
            </mesh>
          )),
        )}
      </group>
    )
  }
  const hall: [number, number, number] = tech === 'ccgt' ? [11, 7, 8] : tech === 'ocgt' ? [8, 5, 6] : [7, 3, 5]
  const stacks = tech === 'ccgt' ? 2 : tech === 'ocgt' ? 1 : 3
  const stackH = tech === 'ccgt' ? 16 : tech === 'ocgt' ? 12 : 6
  return (
    <group scale={[s, 1, s]}>
      <mesh position={[0, hall[1] / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={hall} />
        <meshStandardMaterial ref={glowRef} color={body} roughness={0.6} emissive="#ffb347" emissiveIntensity={0} />
      </mesh>
      {Array.from({ length: stacks }, (_, i) => (
        <mesh key={i} position={[hall[0] / 2 - 1 - i * 2.6, stackH / 2, -hall[2] / 2 + 1]} castShadow>
          <cylinderGeometry args={[tech === 'diesel' ? 0.35 : 0.9, tech === 'diesel' ? 0.45 : 1.1, stackH, 12]} />
          <meshStandardMaterial color={tech === 'diesel' ? '#3b3b3b' : '#9aa0a8'} roughness={0.7} />
        </mesh>
      ))}
      {tech === 'ccgt' && (
        <mesh position={[-hall[0] / 2 - 2.5, 4, 0]} castShadow>
          <cylinderGeometry args={[2.4, 3.2, 8, 16]} />
          <meshStandardMaterial color="#cfd5dc" roughness={0.8} />
        </mesh>
      )}
    </group>
  )
}

/* ------------------------------------------------------------------------------------------------ lines */

function lineColor(c: CorridorView): THREE.Color {
  const load = c.limitKw > 0 ? Math.abs(c.flowKw) / c.limitKw : 0
  if (c.congested || load >= 0.98) return C.red
  if (load >= 0.75) return C.amber
  return C.teal
}

const PowerLine = memo(function PowerLine({ c, route, overlay, selected, highlight, onSelect }: { c: CorridorView; route: ReturnType<typeof lineRoute>; overlay: 'normal' | 'grid'; selected: boolean; highlight: boolean; onSelect: WorldProps['onSelect'] }) {
  const col = lineColor(c)
  const width = overlay === 'grid' ? 0.55 : 0.22
  const curve = useMemo(() => new THREE.CatmullRomCurve3(route.points.map(([x, y, z]) => new THREE.Vector3(x, y, z))), [route])
  const tube = useMemo(() => new THREE.TubeGeometry(curve, route.points.length * 2, width, 6, false), [curve, width, route.points.length])
  const halo = useMemo(() => new THREE.TubeGeometry(curve, route.points.length * 2, width + 0.6, 6, false), [curve, width, route.points.length])
  const mat = useRef<THREE.MeshBasicMaterial>(null)
  useFrame(({ clock }) => {
    if (mat.current) mat.current.opacity = c.congested ? 0.7 + Math.sin(clock.elapsedTime * 6) * 0.3 : overlay === 'grid' ? 0.95 : 0.75
  })
  return (
    <group
      onClick={(e) => {
        e.stopPropagation()
        onSelect({ kind: 'corridor', id: c.corridorId })
      }}
    >
      <mesh geometry={tube}>
        <meshBasicMaterial ref={mat} color={col} transparent opacity={0.8} />
      </mesh>
      {route.towers.map(([x, z], i) => (
        <mesh key={i} position={[x, 3.6, z]} castShadow>
          <boxGeometry args={[0.5, 7.2, 0.5]} />
          <meshStandardMaterial color="#9aa3ad" metalness={0.5} roughness={0.5} />
        </mesh>
      ))}
      {(selected || highlight) && (
        <mesh geometry={halo}>
          <meshBasicMaterial color={highlight ? '#fbbf24' : '#ffffff'} transparent opacity={0.35} />
        </mesh>
      )}
      {highlight && <group position={[route.towers[Math.floor(route.towers.length / 2)][0], 0, route.towers[Math.floor(route.towers.length / 2)][1]]}><Beacon y={14} /></group>}
    </group>
  )
})

function pointOn(points: [number, number, number][], u: number, out: THREE.Vector3) {
  const f = Math.max(0, Math.min(0.9999, u)) * (points.length - 1)
  const i = Math.floor(f)
  const t = f - i
  const a = points[i]
  const b = points[i + 1]
  out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
}

function FlowDots({ viewRef, routes }: { viewRef: MutableRefObject<RegionView>; routes: Record<string, ReturnType<typeof lineRoute>> }) {
  const PER = 10
  const ids = Object.keys(routes)
  const ref = useRef<THREE.InstancedMesh>(null)
  const phase = useRef<number[]>(ids.flatMap(() => Array.from({ length: PER }, (_, i) => i / PER)))
  const v3 = useMemo(() => new THREE.Vector3(), [])
  const m = useMemo(() => new THREE.Matrix4(), [])
  const col = useMemo(() => new THREE.Color(), [])
  useFrame((_, dt) => {
    if (!ref.current) return
    const v = viewRef.current
    ids.forEach((id, li) => {
      const c = v.corridors.find((x) => x.corridorId === id)
      if (!c) return
      const load = c.limitKw > 0 ? Math.abs(c.flowKw) / c.limitKw : 0
      const dir = Math.sign(c.flowKw)
      col.copy(lineColor(c))
      for (let k = 0; k < PER; k++) {
        const idx = li * PER + k
        phase.current[idx] = (phase.current[idx] + dir * dt * (0.03 + load * 0.16) + 1) % 1
        pointOn(routes[id].points, phase.current[idx], v3)
        const size = dir === 0 ? 0.0001 : 0.55 + load * 0.5
        m.makeScale(size, size, size).setPosition(v3)
        ref.current!.setMatrixAt(idx, m)
        ref.current!.setColorAt(idx, col)
      }
    })
    ref.current.instanceMatrix.needsUpdate = true
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true
  })
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, ids.length * PER]}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}

/* ------------------------------------------------------------------------------------- smoke & industry */

function Smoke({ viewRef, pads, nodePos, lowQ }: { viewRef: MutableRefObject<RegionView>; pads: Record<string, Vec2>; nodePos: Record<NodeId, Vec2>; lowQ: boolean }) {
  const N = lowQ ? 120 : 320
  const ref = useRef<THREE.InstancedMesh>(null)
  const parts = useRef(Array.from({ length: N }, () => ({ x: 0, y: -100, z: 0, life: 0, size: 1, dark: false })))
  const acc = useRef<Record<string, number>>({})
  const m = useMemo(() => new THREE.Matrix4(), [])
  const col = useMemo(() => new THREE.Color(), [])
  const chimneys = useMemo(() => {
    const n = nodePos.industrial_south
    const r = rng('chim:industrial_south')
    return Array.from({ length: 6 }, () => [n[0] + (r() - 0.5) * 30, n[1] + (r() - 0.5) * 30] as Vec2)
  }, [nodePos])
  useFrame((_, dt) => {
    if (!ref.current) return
    const v = viewRef.current
    const emitters: { key: string; x: number; y: number; z: number; rate: number; dark: boolean }[] = []
    for (const pl of v.plants) {
      if (pl.status !== 'online' || pl.outputKw <= 0 || !pl.fuel) continue
      const pad = pads[pl.plantId]
      if (!pad) continue
      const s = Math.min(1.6, 0.6 + Math.sqrt(pl.capacityKw / 120_000) * 0.6)
      emitters.push({ key: pl.plantId, x: pad[0] + (pl.tech === 'ccgt' ? 4.5 : 3) * s, y: pl.tech === 'ccgt' ? 16 : pl.tech === 'ocgt' ? 12 : 6, z: pad[1] - 2 * s, rate: 2 + (pl.outputKw / pl.capacityKw) * 7, dark: pl.tech === 'diesel' })
    }
    const steel = v.actors.find((a) => a.actorId === 'steel')
    if (steel && steel.state !== 'closed') chimneys.forEach(([x, z], i) => emitters.push({ key: `chim${i}`, x, y: 12, z, rate: (steel.productionBps / 10_000) * 3, dark: true }))
    let cursor = 0
    for (const e of emitters) {
      acc.current[e.key] = (acc.current[e.key] ?? 0) + e.rate * dt
      while (acc.current[e.key] >= 1) {
        acc.current[e.key] -= 1
        for (let k = 0; k < N; k++) {
          const p = parts.current[(cursor + k) % N]
          if (p.life <= 0) {
            Object.assign(p, { x: e.x + (Math.random() - 0.5), y: e.y, z: e.z + (Math.random() - 0.5), life: 1, size: 0.8 + Math.random() * 0.6, dark: e.dark })
            cursor = (cursor + k + 1) % N
            break
          }
        }
      }
    }
    const wind = v.weather.windKph / 30
    parts.current.forEach((p, i) => {
      if (p.life > 0) {
        p.life -= dt * 0.33
        p.y += dt * 3.2
        p.x += dt * (1.2 + wind)
        p.size += dt * 1.3
      }
      const sz = p.life > 0 ? p.size : 0.0001
      m.makeScale(sz, sz, sz).setPosition(p.x, p.y, p.z)
      ref.current!.setMatrixAt(i, m)
      col.setScalar(p.dark ? 0.28 + (1 - p.life) * 0.2 : 0.85)
      ref.current!.setColorAt(i, col)
    })
    ref.current.instanceMatrix.needsUpdate = true
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true
  })
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, N]}>
      <sphereGeometry args={[1, 7, 7]} />
      <meshStandardMaterial transparent opacity={0.55} roughness={1} depthWrite={false} />
    </instancedMesh>
  )
}

/** NPC layer: cars on the roads (busier when the economy is busy) and fuel tankers (busier when plants burn fuel). */
function Traffic({ viewRef, routes, lowQ }: { viewRef: MutableRefObject<RegionView>; routes: Record<string, ReturnType<typeof lineRoute>>; lowQ: boolean }) {
  const N = lowQ ? 40 : 90
  const ids = Object.keys(routes)
  const ref = useRef<THREE.InstancedMesh>(null)
  const ground = useMemo(() => Object.fromEntries(ids.map((id) => [id, routes[id].points.map(([x, , z]) => [x, 0.6, z] as [number, number, number])])), [routes])
  const cars = useRef(Array.from({ length: N }, (_, i) => ({ line: ids[i % ids.length], u: (i * 0.137) % 1, dir: i % 2 ? 1 : -1, speed: 0.02 + (i % 5) * 0.006, truck: i % 6 === 0 })))
  const m = useMemo(() => new THREE.Matrix4(), [])
  const v3 = useMemo(() => new THREE.Vector3(), [])
  const ahead = useMemo(() => new THREE.Vector3(), [])
  const q = useMemo(() => new THREE.Quaternion(), [])
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const sc = useMemo(() => new THREE.Vector3(), [])
  const col = useMemo(() => new THREE.Color(), [])
  useFrame((_, dt) => {
    if (!ref.current) return
    const v = viewRef.current
    const busy = v.economy.regionOutputBps / 10_000
    const fuelBurn = v.plants.filter((p) => p.fuel && p.status === 'online' && p.outputKw > 0).length / Math.max(1, v.plants.filter((p) => p.fuel).length)
    const night = v.clock.isNight
    cars.current.forEach((c, i) => {
      const active = c.truck ? i / N < fuelBurn : i / N < 0.25 + busy * 0.75
      c.u = (c.u + c.dir * c.speed * dt + 1) % 1
      const pts = ground[c.line]
      pointOn(pts, c.u, v3)
      pointOn(pts, (c.u + 0.01 * c.dir + 1) % 1, ahead)
      const off = c.dir > 0 ? 1.1 : -1.1
      const dx = ahead.x - v3.x
      const dz = ahead.z - v3.z
      const len = Math.hypot(dx, dz) || 1
      v3.x += (-dz / len) * off
      v3.z += (dx / len) * off
      q.setFromAxisAngle(up, Math.atan2(dx, dz))
      const s = active ? 1 : 0.0001
      m.compose(v3, q, sc.set(s * (c.truck ? 1.1 : 0.8), s * (c.truck ? 1.1 : 0.6), s * (c.truck ? 3 : 1.6)))
      ref.current!.setMatrixAt(i, m)
      col.set(c.truck ? '#f97316' : night ? '#ffe9a8' : ['#d9dde3', '#3b82f6', '#ef4444', '#111827'][i % 4])
      ref.current!.setColorAt(i, col)
    })
    ref.current.instanceMatrix.needsUpdate = true
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true
  })
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, N]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.5} emissive="#ffffff" emissiveIntensity={0.08} />
    </instancedMesh>
  )
}

/** NPC layer: container ships come and go with the port's trade. */
function Ships({ viewRef }: { viewRef: MutableRefObject<RegionView> }) {
  const refs = useRef<THREE.Group[]>([])
  useFrame(({ clock }) => {
    const port = viewRef.current.actors.find((a) => a.actorId === 'port')
    const busy = port ? port.productionBps / 10_000 : 0
    refs.current.forEach((g, i) => {
      if (!g) return
      const t = (clock.elapsedTime * 0.012 * (0.3 + busy) + i * 0.37) % 1
      g.position.set(-230 + t * 130, 0.4, 95 + i * 22)
      g.visible = busy > 0.1 || i === 0
    })
  })
  return (
    <>
      {[0, 1, 2].map((i) => (
        <group key={i} ref={(g) => (refs.current[i] = g!)}>
          <mesh castShadow>
            <boxGeometry args={[18, 2, 5]} />
            <meshStandardMaterial color="#26313d" />
          </mesh>
          {[-5, -1.5, 2, 5.5].map((x, k) => (
            <mesh key={k} position={[x, 2, 0]} castShadow>
              <boxGeometry args={[3, 2, 4]} />
              <meshStandardMaterial color={['#e25d33', '#2563eb', '#16a34a', '#f59e0b'][(i + k) % 4]} />
            </mesh>
          ))}
        </group>
      ))}
    </>
  )
}

/* ---------------------------------------------------------------------------------------------- weather */

function Weather({ viewRef, lowQ }: { viewRef: MutableRefObject<RegionView>; lowQ: boolean }) {
  const CLOUDS = 26
  const cloudRef = useRef<THREE.InstancedMesh>(null)
  const seeds = useMemo(() => {
    const r = rng('clouds')
    return Array.from({ length: CLOUDS * 4 }, (_, i) => ({ cx: -260 + r() * 520, cz: -220 + r() * 420, dx: (r() - 0.5) * 18, dz: (r() - 0.5) * 10, dy: r() * 4, s: 6 + r() * 7, cluster: Math.floor(i / 4) }))
  }, [])
  const RAIN = lowQ ? 600 : 1600
  const rain = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const pos = new Float32Array(RAIN * 3)
    const r = rng('rain')
    for (let i = 0; i < RAIN; i++) {
      pos[i * 3] = -220 + r() * 440
      pos[i * 3 + 1] = r() * 90
      pos[i * 3 + 2] = -180 + r() * 360
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return g
  }, [RAIN])
  const rainMat = useRef<THREE.PointsMaterial>(null)
  const cloudMat = useRef<THREE.MeshStandardMaterial>(null)
  const drift = useRef(0)
  const m = useMemo(() => new THREE.Matrix4(), [])
  const col = useMemo(() => new THREE.Color(), [])
  useFrame((_, dt) => {
    const v = viewRef.current
    const cloud = v.weather.cloudPct / 100
    const storm = v.weather.condition === 'storm'
    drift.current += dt * (1 + v.weather.windKph / 8)
    if (cloudRef.current) {
      const visible = Math.round(CLOUDS * cloud)
      seeds.forEach((sd, i) => {
        const on = sd.cluster < visible
        const x = ((sd.cx + drift.current + 260) % 520) - 260 + sd.dx
        const s = on ? sd.s : 0.0001
        m.makeScale(s * 1.6, s * 0.55, s).setPosition(x, 95 + sd.dy, sd.cz + sd.dz)
        cloudRef.current!.setMatrixAt(i, m)
        col.setScalar(storm ? 0.55 : v.clock.isNight ? 0.5 : 1 - cloud * 0.25)
        cloudRef.current!.setColorAt(i, col)
      })
      cloudRef.current.instanceMatrix.needsUpdate = true
      if (cloudRef.current.instanceColor) cloudRef.current.instanceColor.needsUpdate = true
    }
    if (cloudMat.current) cloudMat.current.opacity = THREE.MathUtils.lerp(cloudMat.current.opacity, (v.clock.isNight ? 0.12 : 0.32) + (storm ? 0.25 : 0), Math.min(1, dt))
    const raining = v.weather.condition === 'rain' || storm
    if (rainMat.current) rainMat.current.opacity = THREE.MathUtils.lerp(rainMat.current.opacity, raining ? 0.65 : 0, Math.min(1, dt * 2))
    if (raining) {
      const a = rain.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < RAIN; i++) {
        let y = a.getY(i) - dt * (storm ? 120 : 80)
        if (y < 0) y += 90
        a.setY(i, y)
      }
      a.needsUpdate = true
    }
  })
  return (
    <>
      <instancedMesh ref={cloudRef} args={[undefined, undefined, CLOUDS * 4]}>
        <sphereGeometry args={[1, 10, 8]} />
        <meshStandardMaterial ref={cloudMat} transparent opacity={0.3} roughness={1} depthWrite={false} emissive="#ffffff" emissiveIntensity={0.08} />
      </instancedMesh>
      <points geometry={rain}>
        <pointsMaterial ref={rainMat} color="#a9c4e8" size={0.7} transparent opacity={0} depthWrite={false} />
      </points>
    </>
  )
}

/* ------------------------------------------------------------------------------------------- build pads */

function BuildPads({ node, used, onBuildAt }: { node: NodeView; used: number; onBuildAt: (n: NodeId) => void }) {
  const pads = useMemo(() => buildPads(node.x, node.z, node.nodeId, used).slice(0, 1), [node, used])
  const ref = useRef<THREE.MeshBasicMaterial>(null)
  useFrame(({ clock }) => ref.current && (ref.current.opacity = 0.35 + Math.sin(clock.elapsedTime * 3) * 0.15))
  return (
    <>
      {pads.map(([x, z], i) => (
        <group
          key={i}
          position={[x, 0.3, z]}
          onClick={(e) => {
            e.stopPropagation()
            onBuildAt(node.nodeId)
          }}
        >
          <mesh rotation-x={-Math.PI / 2}>
            <circleGeometry args={[7, 32]} />
            <meshBasicMaterial ref={ref} color="#fbbf24" transparent opacity={0.4} depthWrite={false} />
          </mesh>
          <Html center position={[0, 2, 0]} zIndexRange={[18, 10]}>
            <button onPointerDown={stopPress} className="pad-chip" onClick={() => onBuildAt(node.nodeId)}>+ Build in {node.name}</button>
          </Html>
        </group>
      ))}
    </>
  )
}

/** The camera controls capture the pointer on press; an in-world button must keep its own press or its tap is lost. */
const stopPress = (e: { stopPropagation: () => void }) => e.stopPropagation()

/* ---------------------------------------------------------------------------------------------- mission */

/** One big, pulsing button standing on the thing to tap. Tapping it does the action. */
function MissionButton({ mission, onMission, nodePos, pads, used, view }: { mission: { target: string; label: string }; onMission: () => void; nodePos: Record<NodeId, Vec2>; pads: Record<string, Vec2>; used: Record<string, number>; view: RegionView }) {
  const [kind, id] = mission.target.split(':')
  let pos: Vec2 | null = null
  if (kind === 'plant') pos = pads[id] ?? null
  else if (kind === 'node') {
    const n = view.nodes.find((x) => x.nodeId === id)
    if (n) pos = buildPads(n.x, n.z, n.nodeId, used[n.nodeId] ?? 0)[0]
  }
  if (!pos) return null
  return (
    <group position={[pos[0], 0, pos[1]]}>
      {kind === 'node' && <GlowPad />}
      <Beacon y={22} />
      <Html center position={[0, 12, 0]} zIndexRange={[19, 19]}>
        <button onPointerDown={stopPress} className="mission-btn" onClick={onMission}>
          {mission.label}
        </button>
      </Html>
    </group>
  )
}

function GlowPad() {
  const ref = useRef<THREE.MeshBasicMaterial>(null)
  useFrame(({ clock }) => ref.current && (ref.current.opacity = 0.35 + Math.sin(clock.elapsedTime * 3) * 0.2))
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, 0.3, 0]}>
      <circleGeometry args={[8, 40]} />
      <meshBasicMaterial ref={ref} color="#fbbf24" transparent opacity={0.4} depthWrite={false} />
    </mesh>
  )
}

/* ------------------------------------------------------------------------------------------------ chips */

function NodeChip({ node, overlay, selected, highlight, onSelect }: { node: NodeView; overlay: 'normal' | 'grid'; selected: boolean; highlight: boolean; onSelect: WorldProps['onSelect'] }) {
  const tone = node.shedKw > 0 ? 'crisis' : node.priceCcPerMWh >= 25_000 ? 'warn' : node.curtailedKw > 0 ? 'tight' : 'ok'
  return (
    <group position={[node.x, node.nodeId === 'central_city' ? 44 : 22, node.z]}>
      {highlight && <Beacon y={10} />}
      <Html center zIndexRange={[18, 10]}>
        <button onPointerDown={stopPress} className={`node-chip ${tone} ${selected ? 'selected' : ''} ${highlight ? 'hl' : ''}`} onClick={() => onSelect({ kind: 'node', id: node.nodeId })}>
          {node.shedKw > 0 && <span className="nc-alarm">⚠ LIGHTS OUT</span>}
          <span className="nc-name">{node.name}</span>
          <span className="nc-price">{price(node.priceCcPerMWh)}<small>/MWh</small></span>
          {node.shedKw > 0 ? <span className="nc-tag crisis">{mw(node.shedKw)} dark</span> : overlay === 'grid' ? <span className="nc-tag">{mw(node.generationKw)} gen · {mw(node.servedKw)} load</span> : null}
        </button>
      </Html>
    </group>
  )
}

function LineChip({ c, route, onSelect }: { c: CorridorView; route: ReturnType<typeof lineRoute>; onSelect: WorldProps['onSelect'] }) {
  const mid = route.towers[Math.floor(route.towers.length / 2)]
  return (
    <Html center position={[mid[0], 10, mid[1]]} zIndexRange={[16, 10]}>
      <button onPointerDown={stopPress} className={`line-chip ${c.congested ? 'crisis' : ''}`} onClick={() => onSelect({ kind: 'corridor', id: c.corridorId })}>
        {mw(Math.abs(c.flowKw))} / {mw(c.limitKw)}
        {c.congested && <b> FULL · Δ{price(Math.abs(c.spreadCcPerMWh))}</b>}
      </button>
    </Html>
  )
}

function PlantChip({ plant, pos, onSelect }: { plant: PlantView; pos: Vec2; onSelect: WorldProps['onSelect'] }) {
  const status = plant.status === 'online' ? (plant.tech === 'battery' ? (plant.netKw > 0 ? `▲ ${mw(plant.netKw)}` : plant.netKw < 0 ? `▼ ${mw(-plant.netKw)}` : `${Math.round((plant.socKwh * 100) / Math.max(1, plant.energyKwh))}%`) : mw(plant.outputKw)) : plant.status
  return (
    <Html center position={[pos[0], 13, pos[1]]} zIndexRange={[17, 10]}>
      <button onPointerDown={stopPress} className={`plant-chip ${plant.mine ? 'mine' : ''} s-${plant.status}`} onClick={() => onSelect({ kind: 'plant', id: plant.plantId })}>
        {plant.name} <b>{status}</b>
      </button>
    </Html>
  )
}

/* --------------------------------------------------------------------------------------------- camera */

function Controls({ focus, nodePos, pads, routes, onZoom, view }: { focus: FocusCmd | null; nodePos: Record<NodeId, Vec2>; pads: Record<string, Vec2>; routes: Record<string, ReturnType<typeof lineRoute>>; onZoom: (z: ZoomLevel) => void; view: RegionView }) {
  const ref = useRef<ElementRef<typeof CameraControls>>(null)
  const [level, setLevel] = useState<ZoomLevel>('REGION')
  useEffect(() => {
    const c = ref.current
    if (!c || !focus) return
    let x = 0
    let z = 0
    let dist = 140
    if (focus.kind === 'home') {
      void c.setLookAt(0, 175, 205, 0, 0, 0, true)
      return
    }
    if (focus.kind === 'node') {
      ;[x, z] = nodePos[focus.id as NodeId] ?? [0, 0]
      dist = 110
    } else if (focus.kind === 'plant') {
      ;[x, z] = pads[focus.id] ?? [0, 0]
      dist = 95
    } else if (focus.kind === 'actor') {
      const a = view.actors.find((y) => y.actorId === focus.id)
      if (a) {
        const np = nodePos[a.nodeId]
        const sp = ACTOR_SPOT[a.actorId] ?? { dx: 0, dz: 0 }
        ;[x, z] = [np[0] + sp.dx, np[1] + sp.dz]
      }
      dist = 70
    } else if (focus.kind === 'merchant') {
      const i = MARKET_ORDER.indexOf(focus.id)
      ;[x, z] = stallPos(Math.max(0, i))
      dist = 70
    } else if (focus.kind === 'corridor') {
      const r = routes[focus.id]
      if (r) [x, z] = r.towers[Math.floor(r.towers.length / 2)]
      dist = 120
    }
    if (focus.dist) dist = focus.dist
    void c.setLookAt(x, dist * 0.75, z + dist * 0.75, x, 0, z, true)
  }, [focus?.nonce])
  useFrame(() => {
    const c = ref.current
    if (!c) return
    const d = c.distance
    const l: ZoomLevel = d > 220 ? 'REGION' : d > 125 ? 'LOAD CENTER' : d > 65 ? 'DISTRICT' : 'BUSINESS'
    if (l !== level) {
      setLevel(l)
      onZoom(l)
    }
  })
  return <CameraControls ref={ref} makeDefault minDistance={28} maxDistance={420} maxPolarAngle={1.32} minPolarAngle={0.25} dollySpeed={0.6} smoothTime={0.45} />
}

/* ------------------------------------------------------------------------------------------ Vesper Market */

export const MARKET_CENTER: Vec2 = [-54, -26]
const MARKET_ORDER = ['ingrid', 'bayo', 'kettle', 'dayo', 'chioma', 'lena', 'ruth', 'pavel', 'nkechi']
const AWNING = ['#2563eb', '#0ea5e9', '#b45309', '#f97316', '#be185d', '#16a34a', '#7c3aed', '#64748b', '#ca8a04']
const stallPos = (i: number): Vec2 => [MARKET_CENTER[0] + ((i % 3) - 1) * 11, MARKET_CENTER[1] + (Math.floor(i / 3) - 1) * 10]

/** The market square: nine stalls with live price signs. A stall goes dark when its shop closes and sparkles on a trade. */
function MarketStreet({ town, simple, far, selected, onSelect }: { town: TownView; simple: boolean; far: boolean; selected: string | null; onSelect: WorldProps['onSelect'] }) {
  const closed = town.merchants.filter((m) => !m.open).length
  const townRef = useRef(town)
  townRef.current = town
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[MARKET_CENTER[0], 0.05, MARKET_CENTER[1]]} receiveShadow>
        <planeGeometry args={[40, 36]} />
        <meshStandardMaterial color="#8a7f6e" roughness={1} />
      </mesh>
      {!simple && (
        <Html center position={[MARKET_CENTER[0], 1, MARKET_CENTER[1] + 19]} zIndexRange={[15, 10]}>
          <button
            onPointerDown={stopPress}
            className={`market-sign ${closed ? 'has-closed' : ''}`}
            onClick={() => onSelect({ kind: 'merchant', id: MARKET_ORDER[0] })}
            title="Zoom in to see every stall's prices"
          >
            VESPER MARKET {far && <small>· {town.merchants.length - closed} open{closed ? ` · ${closed} closed` : ''}</small>}
          </button>
        </Html>
      )}
      {MARKET_ORDER.map((id, i) => {
        const m = town.merchants.find((x) => x.merchantId === id)
        if (!m) return null
        const [x, z] = stallPos(i)
        return <Stall key={id} id={id} x={x} z={z} color={AWNING[i]} townRef={townRef} open={m.open} selected={selected === id} showSign={!simple && (!far || selected === id || !m.open)} onSelect={onSelect} />
      })}
    </group>
  )
}

function Stall({ id, x, z, color, townRef, open, selected, showSign, onSelect }: { id: string; x: number; z: number; color: string; townRef: MutableRefObject<TownView>; open: boolean; selected: boolean; showSign: boolean; onSelect: WorldProps['onSelect'] }) {
  const lastTrade = useRef<number | null>(null)
  const sparks = useRef<THREE.Group>(null)
  const sparkT = useRef(99)
  useFrame((_, dt) => {
    const m = townRef.current.merchants.find((y) => y.merchantId === id)
    if (!m) return
    if (lastTrade.current !== null && m.lastTradeAt !== lastTrade.current) sparkT.current = 0
    lastTrade.current = m.lastTradeAt
    sparkT.current += dt
    if (sparks.current) {
      const k = sparkT.current
      sparks.current.visible = k < 1.4
      sparks.current.position.y = 6 + k * 6
      sparks.current.scale.setScalar(1 - Math.min(1, k / 1.4) * 0.6)
    }
  })
  const m = townRef.current.merchants.find((y) => y.merchantId === id)!
  const main = m.items[0]
  const price = main.askCc ?? main.bidCc ?? 0
  const up = main.askCc && main.askAnHourAgoCc ? main.askCc > main.askAnHourAgoCc * 1.02 : false
  const down = main.askCc && main.askAnHourAgoCc ? main.askCc < main.askAnHourAgoCc * 0.98 : false
  return (
    <group
      position={[x, 0, z]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect({ kind: 'merchant', id })
      }}
    >
      <mesh position={[0, 1.6, 0]} castShadow receiveShadow>
        <boxGeometry args={[7, 3.2, 5]} />
        <meshStandardMaterial color={open ? '#e9dfcc' : '#4b4b4b'} roughness={0.8} emissive={open ? '#ffd28a' : '#000000'} emissiveIntensity={open ? 0.12 : 0} />
      </mesh>
      <mesh position={[0, 3.6, 1.6]} rotation-x={0.35} castShadow>
        <boxGeometry args={[7.6, 0.3, 3.4]} />
        <meshStandardMaterial color={open ? color : '#3a3a3a'} roughness={0.6} />
      </mesh>
      {[-1.8, 0, 1.8].map((dx) => (
        <mesh key={dx} position={[dx, 3.3, 0]}>
          <boxGeometry args={[1.2, 0.8, 1.2]} />
          <meshStandardMaterial color={open ? '#c8a96a' : '#333'} />
        </mesh>
      ))}
      <group ref={sparks} visible={false}>
        {[[-1, 0], [1, 0.5], [0, -0.8], [0.6, 1]].map(([sx, sz], k) => (
          <mesh key={k} position={[sx, 0, sz]}>
            <sphereGeometry args={[0.45, 8, 8]} />
            <meshBasicMaterial color="#fde047" toneMapped={false} />
          </mesh>
        ))}
      </group>
      {selected && <SelectRing r={5} />}
      {showSign && (
        <Html center position={[0, 8.5, 0]} zIndexRange={[16, 10]}>
          <button onPointerDown={stopPress} className={`stall-chip ${open ? '' : 'closed'} ${selected ? 'selected' : ''}`} onClick={() => onSelect({ kind: 'merchant', id })}>
            <span>
              {m.face} {m.person.split(' ').slice(-1)[0] === 'Kettle' ? 'Kettle' : m.person.replace('Prof. ', '').split(' ')[0]}
            </span>
            {open ? (
              <b>
                {ITEMS[main.item].icon} ₡{(price / 100).toLocaleString('en-US', { maximumFractionDigits: price < 10_000 ? 2 : 0 })}
                {up ? <em className="up">▲</em> : down ? <em className="down">▼</em> : null}
              </b>
            ) : (
              <b className="closed-tag">CLOSED</b>
            )}
          </button>
        </Html>
      )}
    </group>
  )
}
