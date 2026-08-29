"""Independent numerical verification of the worked examples in the course material.
Run: python3 worklog/verify/verify_course_examples.py
"""
import math
from math import tan, sin, cos, exp, pi, atan, log, sqrt, radians as rad, degrees as deg

def chk(name, got, want, tol=1e-3):
    ok = abs(got-want) <= tol*max(1.0, abs(want))
    print(f"{'OK  ' if ok else 'FAIL'} {name}: got={got:.6g} want={want:.6g}")
    return ok

print("=== SHEET PILE MANUAL §6 (one-level supported, Rankine free-earth) ===")
def solve_supported(H, a, phi_deg, gamma, q):
    phi = rad(phi_deg)
    Ka = tan(pi/4 - phi/2)**2; Kp = tan(pi/4 + phi/2)**2
    A = Ka*(gamma*H + q); B = gamma*(Ka-Kp)
    Mabove = Ka*gamma*(H**3/3 - a*H**2/2) + Ka*q*(H**2/2 - a*H)
    f = lambda D: Mabove + A*((H-a)*D + D*D/2) + B*((H-a)*D*D/2 + D**3/3)
    lo, hi = 0.01, 50.0
    for _ in range(200):
        mid = 0.5*(lo+hi)
        if f(mid) > 0: lo = mid
        else: hi = mid
    D = 0.5*(lo+hi)
    T = Ka*gamma*H*H/2 + Ka*q*H + A*D + B*D*D/2
    z0 = -A/B
    # M(y) scan
    N = 200000; L = H + D; best = (0,0)
    for i in range(N+1):
        y = L*i/N
        if y <= H:
            M = Ka*gamma*y**3/6 + Ka*q*y*y/2 - (T*(y-a) if y >= a else 0)
        else:
            z = y-H
            VH = Ka*gamma*H*H/2 + Ka*q*H - T
            MH = Ka*gamma*H**3/6 + Ka*q*H*H/2 - T*(H-a)
            M = MH + VH*z + A*z*z/2 + B*z**3/6
        if abs(M) > abs(best[0]): best = (M, y)
    return dict(Ka=Ka, Kp=Kp, A=A, B=B, Mabove=Mabove, D=D, T=T, z0=z0, Mmax=abs(best[0]), yM=best[1])
r = solve_supported(6.0, 1.2, 30.0, 18.0, 10.0)
chk("A", r['A'], 39.3333); chk("B", r['B'], -48.0); chk("Mabove", r['Mabove'], 338.4)
chk("D (SLS)", r['D'], 2.4362, 1e-4); chk("T (SLS)", r['T'], 81.380, 1e-4); chk("z0", r['z0'], 0.8194, 1e-3)
chk("Mmax (SLS)", r['Mmax'], 144.209, 2e-4); chk("y at Mmax", r['yM'], 4.6825, 1e-3)
r2 = solve_supported(6.0, 1.2, 30.0, 18.0, 11.0)
chk("D (BGT+aver)", r2['D'], 2.4513, 1e-4); chk("T (BGT+aver)", r2['T'], 83.021, 1e-4); chk("Mmax (BGT+aver)", r2['Mmax'], 146.265, 2e-4)
chk("T x1.35", r2['T']*1.35, 112.078, 1e-4); chk("M x1.35", r2['Mmax']*1.35, 197.458, 2e-4)
phid = deg(atan(tan(rad(30))/1.25))
chk("phi_d", phid, 24.7913, 1e-4)
r3 = solve_supported(6.3, 1.2, phid, 18.0, 11.0)
chk("Ka,d", r3['Ka'], 0.4091315, 1e-5); chk("Kp,d", r3['Kp'], 2.4442018, 1e-5)
chk("A d", r3['A'], 50.89596, 1e-5); chk("B d", r3['B'], -36.63127, 1e-5)
chk("Mabove d", r3['Mabove'], 493.7256, 1e-5); chk("D d", r3['D'], 3.56806, 1e-4)
chk("T d", r3['T'], 122.9213, 1e-4); chk("z0 d", r3['z0'], 1.38941, 1e-4)
chk("Mmax d", r3['Mmax'], 258.2326, 2e-4); chk("y Mmax d", r3['yM'], 5.19899, 1e-3)
# pressure at surface / excavation / toe
chk("p surface", r3['Ka']*11, 4.5, 1e-3); chk("p toe", r3['A']+r3['B']*r3['D'], -79.807, 1e-3)
# cantilever illustration §4.3: H=3, phi=30, gamma=18, q=0
H, g, Ka, Kp = 3.0, 18.0, 1/3, 3.0
A = Ka*g*H; B = g*(Ka-Kp)
f = lambda D: Ka*g*(H**3/6 + D*H*H/2) + A*D*D/2 + B*D**3/6
lo, hi = 0.01, 50
for _ in range(200):
    mid=0.5*(lo+hi)
    if f(mid) > 0: lo=mid
    else: hi=mid
D0 = 0.5*(lo+hi)
chk("cantilever z0", -A/B, 0.375); chk("cantilever D0", D0, 2.778, 1e-3)
Rt = -(Ka*g*H*H/2 + A*D0 + B*D0*D0/2)
chk("cantilever |Rt|", abs(Rt), 108.2, 1e-3)
# water sensitivity (differential head, DA1/2): retained WT at surface, front WT at excavation
def solve_supported_water(H, a, phi_deg, gsat, gw, q):
    phi = rad(phi_deg); Ka = tan(pi/4-phi/2)**2; Kp = tan(pi/4+phi/2)**2
    gp = gsat-gw
    # net pressure: above exc: Ka(gp*y+q)+gw*y ; below: Ka(gp(H+z)+q) + gw(H+z) - Kp gp z - gw z
    def moment(D):
        N=4000; L=H+D; s=0
        for i in range(N):
            y=(i+0.5)*L/N
            if y<=H: p = Ka*(gp*y+q)+gw*y
            else:
                z=y-H; p = Ka*(gp*(H+z)+q)+gw*H - Kp*gp*z
            s += p*(y-a)*L/N
        return s
    lo,hi=0.01,60
    for _ in range(100):
        mid=0.5*(lo+hi)
        if moment(mid)>0: lo=mid
        else: hi=mid
    return 0.5*(lo+hi)
Dw = solve_supported_water(6.3, 1.2, phid, 20.0, 9.81, 11.0)
chk("water case D (approx, hydrostatic simplified)", Dw, 8.653, 5e-3)

print("\n=== BRINCH HANSEN CHAPTER §7 worked example ===")
def bh_consts(phi_deg):
    phi = rad(phi_deg); t = tan(phi)
    Pq = exp((pi/2+phi)*t)*cos(phi)*tan(pi/4+phi/2)
    KqA = exp(-(pi/2-phi)*t)*cos(phi)*tan(pi/4-phi/2)
    Kq0 = Pq - KqA
    Kc0 = (Pq-1)/t
    K0 = 1-sin(phi)
    dc = 1.58 + 4.09*t**4
    Nq = exp(pi*t)*tan(pi/4+phi/2)**2
    Nc = (Nq-1)/t
    Kcinf = Nc*dc
    Kqinf = Kcinf*K0*t
    aq = Kq0/(Kqinf-Kq0)*K0*sin(phi)/sin(pi/4+phi/2)
    ac = Kc0/(Kcinf-Kc0)*2*sin(pi/4+phi/2)
    return dict(Pq=Pq,KqA=KqA,Kq0=Kq0,Kc0=Kc0,K0=K0,dc=dc,Nq=Nq,Nc=Nc,Kcinf=Kcinf,Kqinf=Kqinf,aq=aq,ac=ac)
c = bh_consts(20.5)
for k,w in [('Pq',2.776880),('KqA',0.412869),('Kq0',2.364011),('Kc0',4.752482),('K0',0.649793),('dc',1.659923),('Nc',15.314396),('Kcinf',25.420725),('Kqinf',6.175902),('aq',0.171761),('ac',0.377861)]:
    chk(f"BH {k}", c[k], w, 1e-5)
chk("Ka(20.5)", tan(pi/4-rad(20.5)/2)**2, 0.4813, 1e-3); chk("Kp(20.5)", tan(pi/4+rad(20.5)/2)**2, 2.0779, 1e-3)
Kq = lambda xi,c: (c['Kq0'] + c['Kqinf']*c['aq']*xi)/(1+c['aq']*xi)
Kc = lambda xi,c: (c['Kc0'] + c['Kcinf']*c['ac']*xi)/(1+c['ac']*xi)
gam, Hr, B = 19.0, 1.60, 0.10
ew = lambda z: gam*z*Kq(z/B,c) - gam*Hr*c['KqA']
for z,kq,e,t in [(0,2.3640,-12.551,0),(0.2,3.3387,0.136,0.014),(0.4,3.9164,17.213,1.721),(0.6,4.2986,36.453,3.645),(0.8,4.5703,56.917,5.692),(1.0,4.7732,78.140,7.814),(1.2,4.9306,99.868,9.987),(1.4,5.0563,121.946,12.195)]:
    chk(f"Kq(z={z})", Kq(z/B,c), kq, 1e-4); chk(f"ew(z={z})", ew(z), e, 1e-3 if abs(e)>1 else 2e-2)
# zero crossing
lo,hi=0.0,0.5
for _ in range(100):
    mid=0.5*(lo+hi)
    if ew(mid)<0: lo=mid
    else: hi=mid
chk("z where ew=0", 0.5*(lo+hi), 0.198, 5e-3)
N=200000; Ru=0; Mu=0
for i in range(N):
    z=(i+0.5)*1.4/N; v=max(ew(z),0)*B; Ru+=v*1.4/N; Mu+=v*z*1.4/N
chk("Ru", Ru, 6.981, 1e-3); chk("Mu", Mu, 7.066, 1e-3); chk("zbar", Mu/Ru, 1.012, 1e-3)
# phi->0 limits
chk("Kc0 limit phi->0 (1+pi/2)", 1+pi/2, 2.5708, 1e-4); chk("Nc limit", pi+2, 5.1416, 1e-4); chk("Kcinf limit", 1.58*(pi+2), 8.1237, 1e-4)
c_small = bh_consts(1e-4)
chk("ac limit phi->0 (numerical)", c_small['ac'], 0.6547, 2e-3)
chk("Kc0 numeric phi->0", c_small['Kc0'], 2.5708, 1e-3)

print("\n=== REKENNOTA HEA180 (Brinch Hansen coefficients + Blum) ===")
c25 = bh_consts(25.0)
for k,w in [('Nq',10.6621),('Nc',20.7205),('dc',1.7734),('K0',0.5774),('Kq0',3.2869),('Kc0',5.6339),('Kqinf',9.8932),('Kcinf',36.7454),('aq',0.14395),('ac',0.30545)]:
    chk(f"BH25 {k}", c25[k], w, 2e-4)
chk("Kqinf/Kp(25)", c25['Kqinf']/tan(pi/4+rad(25)/2)**2, 4.015, 1e-3)
phired = deg(atan(tan(rad(25))/1.30)); chk("phi_red 1.30", phired, 19.733, 1e-4)
cr = bh_consts(phired)
for k,w in [('Nq',6.2323),('Nc',14.5867),('dc',1.6477),('K0',0.6624),('Kq0',2.2322),('Kc0',4.6246),('Kqinf',5.7104),('Kcinf',24.0347),('aq',0.17550),('ac',0.38970)]:
    chk(f"BHred {k}", cr[k], w, 2e-4)
Bf=0.180; gam=19.5
def pu(z, cc, cprime):
    sv = gam*z; xi=z/Bf
    return Bf*(sv*Kq(xi,cc) + cprime*Kc(xi,cc))
for z,kq,kc,pk,pr,kps in [(0.25,4.388,14.901,5.19,3.35,12.01),(0.5,5.174,19.915,10.87,6.94,24.02),(1.0,6.223,25.210,24.11,15.10,48.05),(2.0,7.352,29.665,54.28,33.22,96.09),(3.0,7.950,31.638,86.56,52.28,144.14),(4.484,8.453,33.132,136.02,81.22,215.44)]:
    chk(f"Kq25(z={z})", Kq(z/Bf,c25), kq, 1e-3); chk(f"Kc25(z={z})", Kc(z/Bf,c25), kc, 1e-3)
    chk(f"pu_k(z={z})", pu(z,c25,0.5), pk, 2e-3); chk(f"pu_red(z={z})", pu(z,cr,0.5/1.30), pr, 3e-3)
    chk(f"Kp*sv*s (z={z})", tan(pi/4+rad(25)/2)**2*gam*z*1.0, kps, 1e-3)
# Blum with effective width
def blum_hea(SF, Hd=1.916, dh=1.577, s=1.0, b=0.180, gam=19.5):
    phi = atan(tan(rad(25))/SF)
    Ka = tan(pi/4-phi/2)**2; Kp = tan(pi/4+phi/2)**2
    C0 = gam*Hd + gam*dh; C1=gam; C2=gam*dh*dh/2
    # F_a
    I1 = 1.5*gam*dh*dh/2
    I2 = gam*(Hd**2-dh**2)/2 + gam*dh*(Hd-dh) - C2*log(Hd/dh)
    Fa = Ka*(I1+I2)*s
    M1 = 1.5*gam*dh**3/3
    M2 = gam*(Hd**3-dh**3)/3 + gam*dh*(Hd**2-dh**2)/2 - C2*(Hd-dh)
    zbar = (M1+M2)/(I1+I2); a = Hd-zbar
    beff = min(3*b, s)
    a1 = Kp*gam*beff; a2 = Ka*b
    lhs = lambda t: (a1-a2*C1)*t**3/6 - a2*C0*t*t/2 + a2*C2*((t+Hd)*log((Hd+t)/Hd) - t)
    rhs = lambda t: Fa*(a+t)
    lo,hi=0.01,20
    for _ in range(200):
        mid=0.5*(lo+hi)
        if lhs(mid)-rhs(mid) < 0: lo=mid
        else: hi=mid
    t0=0.5*(lo+hi)
    return dict(Ka=Ka,Kp=Kp,Fa=Fa,a=a,t0=t0,Dreq=1.2*t0)
r = blum_hea(1.30)
chk("Ka 1.30", r['Ka'], 0.4952, 1e-3); chk("Kp 1.30", r['Kp'], 2.0195, 1e-3)
chk("Fa 1.30", r['Fa'], 26.55, 1e-3); chk("a", r['a'], 0.6394, 1e-3); chk("t0 1.30", r['t0'], 3.5393, 2e-4); chk("Dreq 1.30", r['Dreq'], 4.247, 1e-3)
r = blum_hea(1.25); chk("t0 1.25", r['t0'], 3.431, 1e-3); chk("Dreq 1.25", r['Dreq'], 4.117, 1e-3)
r = blum_hea(1.0); chk("Fa char", r['Fa']/1.0, 29.38/1.35, 2e-3)
# HEA180 section checks
A=45.25e-4; Wpl=324.9e-6; Wel=293.6e-6; Av=14.47e-4; fy=235e3
chk("Mpl,Rd", Wpl*fy, 76.35, 1e-3); chk("Mel,Rd", Wel*fy, 69.00, 1e-3); chk("Vpl,Rd", Av*fy/sqrt(3), 196.3, 1e-3)
chk("EA/s", 210e6*A, 9.503e5, 1e-3); chk("EI/s", 210e6*2.510e-5, 5271, 1e-3); chk("d_eq", sqrt(12*2.510e-5/A), 0.2580, 1e-3)
chk("ISF", 2.5*(1.0/0.2580)**-0.75, 0.905, 2e-3)
chk("Tskin slope", (1-sin(rad(25)))*(0.36*tan(rad(25*2/3))+0.342*tan(rad(25)))*19.5, 3.009, 2e-3)
chk("Av check", 4525-2*180*9.5+(6+30)*9.5, 1447, 1e-3)

print("\n=== VIBRATORY CHAPTER §8 & §11 ===")
Lam=6; FR=1.0
chi = (1-1/Lam)*exp(-1/FR)+1/Lam
chk("chi", chi, 0.473233, 1e-5)
Ab = pi*0.273**2/4; P=pi*0.273; As=pi/4*(0.273**2-0.257**2)
chk("Ab", Ab, 0.058535, 1e-4); chk("P", P, 0.857655, 1e-5); chk("As", As, 0.006660, 1e-3); chk("Mp", 7850*As*6, 313.7, 1e-3)
Weff = 2200*9.81/1000+15; chk("Weff", Weff, 36.582, 1e-4)
qs,ts = 3000,30; ql=chi*qs; tl=chi*ts
def Rdrive(Fc, Mdyn=2200):
    al = 1000*Fc/(Mdyn*9.81)
    qd = (qs-ql)*exp(-al)+ql; td=(ts-tl)*exp(-al)+tl
    return td*P*3.0 + qd*Ab, al, qd, td
R,al,qd,td = Rdrive(125)
chk("alpha 125", al, 5.7919, 1e-4); chk("qd 125", qd, 1424.522, 1e-5); chk("Rdrive 125", R, 120.037, 1e-4)
chk("G 125", 125+Weff-1.25*R, 11.536, 1e-3)
def root(mR):
    lo,hi=0.0,500
    for _ in range(100):
        mid=0.5*(lo+hi)
        if mid+Weff-mR*Rdrive(mid)[0] < 0: lo=mid
        else: hi=mid
    return 0.5*(lo+hi)
chk("Fc,min mR=1", root(1.0), 85.574, 1e-3); chk("Fc,min mR=1.25", root(1.25), 113.809, 1e-3)
w=2*pi*35; chk("Me", 125000/w**2, 2.5847, 1e-4); chk("s0 mm", 125000/w**2/2200*1000, 1.175, 1e-3)
chk("sigma screen MPa", (125+Weff)*1e3/As/1e6, 24.3, 2e-3)
for k,d,w_ in [(266,1.4,2.275),(266,1.2,4.491),(266,1.3,3.196),(60,1.4,0.513),(126,1.4,1.078),(60,1.3,0.721),(126,1.3,1.514),(60,1.2,1.013),(126,1.2,2.127)]:
    chk(f"TRL kv={k} d={d}", k/30**d, w_, 1e-3)
chk("BS7385 at 35 Hz", 20+30/25*(35-15), 44.0); chk("DIN4150 at 35Hz", 5+(15-5)/(50-10)*(35-10), 11.25)
n = log(5/2)/log(20/10); chk("power law n", n, 1.3219, 1e-4); K=5*10**n; chk("K", K, 104.93, 1e-4); chk("v30", K*30**-n, 1.17, 5e-3)
# sensitivity table entries
def root_case(fs_, lam_, crowd):
    global ql,tl,ts,Weff
    ts_=fs_; chi_=(1-1/lam_)*exp(-1/(100*fs_/3000))+1/lam_
    ql_=chi_*3000; tl_=chi_*ts_; We=2200*9.81/1000+crowd
    def Rd(Fc):
        al=1000*Fc/(2200*9.81); return ((ts_-tl_)*exp(-al)+tl_)*P*3+((3000-ql_)*exp(-al)+ql_)*Ab
    lo,hi=0,800
    for _ in range(100):
        mid=0.5*(lo+hi)
        if mid+We-1.25*Rd(mid)<0: lo=mid
        else: hi=mid
    return 0.5*(lo+hi)
chk("sens fs=15", root_case(15,6,15), 54.0, 2e-3); chk("sens fs=60", root_case(60,6,15), 240.7, 2e-3)
chk("sens Lam=4", root_case(30,4,15), 130.0, 2e-3); chk("sens Lam=10", root_case(30,10,15), 101.3, 2e-3)
chk("sens crowd 0", root_case(30,6,0), 128.4, 2e-3); chk("sens crowd 25", root_case(30,6,25), 104.3, 2e-3)

print("\n=== SBR-A example (T26L053) ===")
chk("allow bouwwerk", 5/(1.7*1.6*1.5), 1.23, 5e-3); chk("allow non-lb", 15/(1.7*1.6*1.5), 3.68, 5e-3); chk("allow fundering", 10/(1.7*1.6*1.6), 2.30, 5e-3)
