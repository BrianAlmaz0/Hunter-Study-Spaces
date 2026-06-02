import { useState, useEffect } from 'react';
import { HomeScreen } from './components/HomeScreen';
import { ResultsScreen } from './components/ResultsScreen';
import { DetailScreen } from './components/DetailScreen';
import { FavoritesScreen } from './components/FavoritesScreen';
import { LoginScreen } from './LoginScreen';
import { Home, Search, Heart, ChevronLeft, LogOut, Users } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { API } from './api';

type Screen = 'home' | 'results' | 'detail' | 'favorites';

interface SearchFilters {
  building?: string;
  roomType?: string;
  floor?: string;
  day: string;
  time: string;
  date: string;
}

interface Room {
  id: string;
  building: string;
  roomNumber: string;
  floor: number | string;
  availableFor: number | null;
  nextClass: string | null;
  type: string;
  capacity?: number;
  isAvailable?: boolean;
  studentOccupancyCount?: number;
  isStudentReportedOccupied?: boolean;
}

interface OccupancyReport {
  room: string;
  building: string | null;
  expiresAt: string;
  createdAt: string;
}

interface StudentUser {
  name: string;
  email: string;
}


function computeTimeRemaining(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export default function App() {
  const [user, setUser] = useState<StudentUser | null>(null);
  const [isVerifying, setIsVerifying] = useState(true);

  const [currentScreen, setCurrentScreen] = useState<Screen>('home');
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [isDesktop, setIsDesktop] = useState(false);
  const [searchResults, setSearchResults] = useState<Room[]>([]);
  const [allRooms, setAllRooms] = useState<Room[]>([]);
  const [buildings, setBuildings] = useState<string[]>([]);
  const [buildingFloors, setBuildingFloors] = useState<Record<string, string[]>>({});
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({
    day:  new Date().toLocaleString('en-US', { weekday: 'long' }),
    time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
    date: new Date().toISOString().split('T')[0],
  });
  const [currentOccupancy, setCurrentOccupancy] = useState<OccupancyReport | null>(null);

  useEffect(() => {
    const checkDesktop = () => setIsDesktop(window.innerWidth >= 1024);
    checkDesktop();
    window.addEventListener('resize', checkDesktop);
    return () => window.removeEventListener('resize', checkDesktop);
  }, []);

  useEffect(() => {
    const verifySession = async () => {
      const token = localStorage.getItem('auth_token');
      if (!token) { setIsVerifying(false); return; }

      try {
        const res = await fetch(`${API}/api/auth/verify`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setUser(data.student);
          localStorage.setItem('student_session', JSON.stringify(data.student));
        } else {
          localStorage.removeItem('auth_token');
          localStorage.removeItem('student_session');
        }
      } catch {
        const cached = localStorage.getItem('student_session');
        if (cached) {
          try { setUser(JSON.parse(cached)); } catch { }
        }
      } finally {
        setIsVerifying(false);
      }
    };
    verifySession();
  }, []);

  useEffect(() => {
    if (!user) { setFavorites([]); return; }
    const token = localStorage.getItem('auth_token');
    Promise.all([
      fetch(`${API}/api/rooms/buildings`).then(r => r.json()).catch(() => []),
      fetch(`${API}/api/rooms/all`).then(r => r.json()).catch(() => []),
      token
        ? fetch(`${API}/api/favorites`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json()).catch(() => null)
        : Promise.resolve(null),
    ]).then(([buildingList, roomList, favoritesList]) => {
      setBuildings(buildingList);
      setAllRooms(roomList);

      // Per-building maximum floor — used to filter out implausible values that
      // may have been stored by an older version of the floor-inference logic.
      const BUILDING_MAX_FLOOR: Record<string, number> = {
        'West Building':      19,
        'East Building':      17,
        'North Building':     17,
        'Thomas Hunter Hall':  6,
        'Baker Building':      6,
        'Silberman':           8,
        'Roosevelt House':     6,
      };
      const DEFAULT_MAX_FLOOR = 20;

      // Build a per-building → sorted unique floors map from the room list.
      // Special values 'C' (cellar) and 'B' (basement) are always kept.
      // Numeric floors are validated against the building's known maximum.
      const floorsMap: Record<string, string[]> = {};
      for (const room of (roomList as Room[])) {
        if (!room.building || room.floor == null) continue;
        const f   = String(room.floor);
        const max = BUILDING_MAX_FLOOR[room.building] ?? DEFAULT_MAX_FLOOR;
        if (f !== 'C' && f !== 'B') {
          const n = parseInt(f);
          if (isNaN(n) || n < 1 || n > max) continue; // reject implausible floor
        }
        if (!floorsMap[room.building]) floorsMap[room.building] = [];
        if (!floorsMap[room.building].includes(f)) floorsMap[room.building].push(f);
      }
      // Sort: 'C' and 'B' (below-grade) first, then numerically ascending.
      for (const bldg of Object.keys(floorsMap)) {
        floorsMap[bldg] = floorsMap[bldg].sort((a, b) => {
          const subGrade = (v: string) => v === 'C' || v === 'B';
          if (subGrade(a) && subGrade(b)) return a.localeCompare(b);
          if (subGrade(a)) return -1;
          if (subGrade(b)) return 1;
          return parseInt(a) - parseInt(b);
        });
      }
      setBuildingFloors(floorsMap);

      if (Array.isArray(favoritesList)) setFavorites(favoritesList);
    });
  }, [user]);

  const fetchCurrentOccupancy = async () => {
    const token = localStorage.getItem('auth_token');
    if (!token) return;
    try {
      const [occRes, roomsRes] = await Promise.all([
        fetch(`${API}/api/occupancy/me`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API}/api/rooms/all`),
      ]);
      if (occRes.ok) setCurrentOccupancy(await occRes.json());
      if (roomsRes.ok) setAllRooms(await roomsRes.json());
    } catch {}
  };

  const handleOccupancyChange = (occupancy: OccupancyReport | null) => {
    setCurrentOccupancy(occupancy);
    // Background refetch to sync room-level student counts
    fetch(`${API}/api/rooms/all`).then(r => r.ok ? r.json() : null).then(data => {
      if (data) setAllRooms(data);
    }).catch(() => {});
  };

  useEffect(() => {
    if (!user) { setCurrentOccupancy(null); return; }
    fetchCurrentOccupancy();
    const interval = setInterval(fetchCurrentOccupancy, 60 * 1000);
    return () => clearInterval(interval);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const extendOccupancy = async (duration: '1hour' | '2hours' | 'next_class') => {
    const token = localStorage.getItem('auth_token');
    if (!token || !currentOccupancy) return;
    try {
      const res = await fetch(`${API}/api/occupancy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          room: currentOccupancy.room,
          building: currentOccupancy.building,
          duration,
          extend: duration !== 'next_class',
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setCurrentOccupancy(prev => prev ? { ...prev, expiresAt: data.expiresAt } : null);
      }
    } catch {}
  };

  const leaveRoom = async () => {
    const token = localStorage.getItem('auth_token');
    if (!token) return;
    try {
      const res = await fetch(`${API}/api/occupancy/me`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setCurrentOccupancy(null);
    } catch {}
  };

  const handleLoginSuccess = (studentData: StudentUser, token: string) => {
    localStorage.setItem('student_session', JSON.stringify(studentData));
    localStorage.setItem('auth_token', token);
    setUser(studentData);
  };

  const handleLogout = () => {
    localStorage.removeItem('student_session');
    localStorage.removeItem('auth_token');
    setUser(null);
    setFavorites([]);
    setCurrentOccupancy(null);
    setCurrentScreen('home');
    setSelectedRoom(null);
  };

  const handleSearchSubmit = async (filters: SearchFilters) => {
    setIsSearching(true);
    setSearchError(null);
    setSearchFilters(filters);

    try {
      const params = new URLSearchParams({ day: filters.day, time: filters.time, date: filters.date });
      if (filters.building) params.append('building', filters.building);
      if (filters.floor) params.append('floor', filters.floor);

      const res = await fetch(`${API}/api/rooms/available?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to retrieve search results.');

      const data = await res.json();
      setSearchResults(data);
      setCurrentScreen('results');
    } catch (err: any) {
      setSearchError(err.message || 'Network connection failed.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleRoomSelect = (room: Room) => {
    setSelectedRoom(room);
    setCurrentScreen('detail');
  };

  const toggleFavorite = (roomId: string) => {
    const token = localStorage.getItem('auth_token');
    const removing = favorites.includes(roomId);

    setFavorites(prev => removing ? prev.filter(id => id !== roomId) : [...prev, roomId]);

    if (!token) return;
    if (removing) {
      fetch(`${API}/api/favorites/${encodeURIComponent(roomId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    } else {
      fetch(`${API}/api/favorites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ roomId }),
      }).catch(() => {});
    }
  };

  if (isVerifying) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-accent/30">
        <div className="text-muted-foreground text-sm">Verifying session...</div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} isDesktop={isDesktop} />;
  }

  const screens = (
    <AnimatePresence mode="wait">
      {currentScreen === 'home' && (
        <motion.div key="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <HomeScreen onSearch={handleSearchSubmit} isDesktop={isDesktop} buildings={buildings} buildingFloors={buildingFloors} isSearching={isSearching} searchError={searchError} availableNowCount={allRooms.length > 0 ? allRooms.filter(r => r.isAvailable && !r.isStudentReportedOccupied).length : undefined} totalRoomsCount={allRooms.length > 0 ? allRooms.length : undefined} />
        </motion.div>
      )}
      {currentScreen === 'results' && (
        <motion.div key="results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <ResultsScreen rooms={searchResults} favorites={favorites} onRoomSelect={handleRoomSelect} onBack={() => setCurrentScreen('home')} isDesktop={isDesktop} activeRoom={currentOccupancy?.room ?? null} />
        </motion.div>
      )}
      {currentScreen === 'detail' && selectedRoom && (
        <motion.div key="detail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <DetailScreen room={selectedRoom} isFavorite={favorites.includes(selectedRoom.id)} onToggleFavorite={() => toggleFavorite(selectedRoom.id)} isDesktop={isDesktop} searchDay={searchFilters.day} searchTime={searchFilters.time} searchDate={searchFilters.date} isAuthenticated={true} onOccupancyChange={handleOccupancyChange} activeRoom={currentOccupancy?.room ?? null} />
        </motion.div>
      )}
      {currentScreen === 'favorites' && (
        <motion.div key="favorites" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <FavoritesScreen favorites={favorites} rooms={allRooms} onRoomSelect={handleRoomSelect} isDesktop={isDesktop} />
        </motion.div>
      )}
    </AnimatePresence>
  );

  if (isDesktop) {
    return (
      <div className="size-full bg-background flex">
        <div className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col">
          <div className="p-6 border-b border-sidebar-border">
            <h1 className="text-xl text-sidebar-foreground">Hunter Study Space</h1>
            <p className="text-sm text-muted-foreground mt-1">Find study rooms</p>
          </div>

          <div className="flex-1 overflow-y-auto">
            <nav className="p-4">
              <button onClick={() => setCurrentScreen('home')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors mb-2 ${currentScreen === 'home' ? 'bg-sidebar-primary text-sidebar-primary-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}`}>
                <Home className="w-5 h-5" /><span>Search</span>
              </button>
              <button onClick={() => setCurrentScreen('results')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors mb-2 ${currentScreen === 'results' ? 'bg-sidebar-primary text-sidebar-primary-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}`}>
                <Search className="w-5 h-5" /><span>Results</span>
              </button>
              <button onClick={() => setCurrentScreen('favorites')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${currentScreen === 'favorites' ? 'bg-sidebar-primary text-sidebar-primary-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}`}>
                <Heart className="w-5 h-5" /><span>Favorites</span>
              </button>
            </nav>

            {currentOccupancy && (
              <div className="px-4 pb-4">
                <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2 px-1">Current Room</div>
                <div className="bg-sidebar-accent rounded-xl p-3">
                  <div className="text-sm text-sidebar-foreground">{currentOccupancy.room.split(' ').pop()}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 mb-1">{currentOccupancy.building}</div>
                  <div className="flex items-center gap-1.5 text-xs text-amber-600 mb-3">
                    <Users className="w-3 h-3" />
                    {computeTimeRemaining(currentOccupancy.expiresAt)} remaining
                  </div>
                  <div className="space-y-1">
                    <button
                      onClick={() => extendOccupancy('1hour')}
                      className="w-full text-left text-xs px-3 py-2 rounded-lg text-sidebar-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground transition-colors"
                    >
                      + Add 1 hour
                    </button>
                    <button
                      onClick={() => extendOccupancy('2hours')}
                      className="w-full text-left text-xs px-3 py-2 rounded-lg text-sidebar-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground transition-colors"
                    >
                      + Add 2 hours
                    </button>
                    <button
                      onClick={() => extendOccupancy('next_class')}
                      className="w-full text-left text-xs px-3 py-2 rounded-lg text-sidebar-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground transition-colors"
                    >
                      Stay until next class
                    </button>
                    <button
                      onClick={leaveRoom}
                      className="w-full text-left text-xs px-3 py-2 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors text-muted-foreground"
                    >
                      Leave room
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="p-4 border-t border-sidebar-border">
            <div className="text-xs text-muted-foreground mb-3">
              Welcome, {user.name}
            </div>
            <button onClick={handleLogout} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors">
              <LogOut className="w-4 h-4" /><span>Sign Out</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {currentScreen === 'detail' && (
            <div className="bg-card border-b border-border px-8 py-4 flex items-center gap-3">
              <button onClick={() => setCurrentScreen('results')} className="p-2 -ml-2 hover:bg-accent rounded-lg transition-colors">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <h2 className="text-xl text-card-foreground">Room Details</h2>
            </div>
          )}
          {screens}
        </div>
      </div>
    );
  }

  return (
    <div className="size-full bg-background flex flex-col">
      {currentScreen === 'detail' && (
        <div className="bg-card border-b border-border px-4 py-3 flex items-center gap-3">
          <button onClick={() => setCurrentScreen('results')} className="p-2 -ml-2 hover:bg-accent rounded-lg transition-colors">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h3 className="text-lg text-card-foreground">Room Details</h3>
        </div>
      )}

      {currentOccupancy && currentScreen !== 'detail' && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-900 truncate">
                <Users className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{currentOccupancy.room} · {computeTimeRemaining(currentOccupancy.expiresAt)} left</span>
              </div>
              <div className="text-xs text-amber-700">{currentOccupancy.building}</div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={() => extendOccupancy('1hour')} className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded border border-amber-200 hover:bg-amber-200 transition-colors">+1h</button>
              <button onClick={() => extendOccupancy('2hours')} className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded border border-amber-200 hover:bg-amber-200 transition-colors">+2h</button>
              <button onClick={leaveRoom} className="text-xs text-amber-700 px-2 py-1 rounded border border-amber-300 hover:bg-amber-100 transition-colors">Leave</button>
            </div>
          </div>
        </div>
      )}
      {/* Content — padded so last card clears the fixed nav */}
      <div className="flex-1 overflow-auto" style={{ paddingBottom: 'calc(64px + env(safe-area-inset-bottom))' }}>
        {screens}
      </div>

      {/* Fixed bottom nav */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border px-6"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-around max-w-md mx-auto py-3">
          <button onClick={() => setCurrentScreen('home')} className={`flex flex-col items-center gap-1 px-4 py-2 rounded-lg transition-colors ${currentScreen === 'home' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            <Home className="w-6 h-6" /><span className="text-xs">Home</span>
          </button>
          <button onClick={() => setCurrentScreen('results')} className={`flex flex-col items-center gap-1 px-4 py-2 rounded-lg transition-colors ${currentScreen === 'results' || currentScreen === 'detail' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            <Search className="w-6 h-6" /><span className="text-xs">Search</span>
          </button>
          <button onClick={() => setCurrentScreen('favorites')} className={`flex flex-col items-center gap-1 px-4 py-2 rounded-lg transition-colors ${currentScreen === 'favorites' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            <Heart className="w-6 h-6" /><span className="text-xs">Favorites</span>
          </button>
        </div>
      </div>
    </div>
  );
}
