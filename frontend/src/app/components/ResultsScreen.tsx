import { MapPin, Clock, Heart, Users, ChevronLeft } from 'lucide-react';
import { motion } from 'motion/react';

interface Room {
  id: string;
  building: string;
  roomNumber: string;
  floor: number | string;
  availableFor: number | null;
  nextClass: string | null;
  type: string;
  studentOccupancyCount?: number;
  isStudentReportedOccupied?: boolean;
}

interface ResultsScreenProps {
  onRoomSelect: (room: Room) => void;
  onBack?: () => void;
  favorites: string[];
  isDesktop: boolean;
  rooms?: Room[];
  activeRoom?: string | null;
}

const mockRooms: Room[] = [
  { id: '1', building: 'North Building',     roomNumber: 'N402',  floor: 4, availableFor: 125, nextClass: '3:00 PM', type: 'Classroom' },
  { id: '2', building: 'North Building',     roomNumber: 'N305',  floor: 3, availableFor: 45,  nextClass: '2:00 PM', type: 'Lecture Hall' },
  { id: '3', building: 'West Building',      roomNumber: 'W621',  floor: 6, availableFor: 210, nextClass: '4:30 PM', type: 'Classroom' },
  { id: '4', building: 'North Building',     roomNumber: 'N208',  floor: 2, availableFor: 90,  nextClass: '2:45 PM', type: 'Computer Lab' },
  { id: '5', building: 'East Building',      roomNumber: 'E512',  floor: 5, availableFor: 180, nextClass: '4:15 PM', type: 'Classroom' },
  { id: '6', building: 'Thomas Hunter Hall', roomNumber: 'TH304', floor: 3, availableFor: 65,  nextClass: '2:20 PM', type: 'Lecture Hall' },
];

function formatAvailability(minutes: number | null): string {
  if (minutes === null) return 'All day';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins  = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function ResultsScreen({ onRoomSelect, onBack, favorites, isDesktop, rooms = mockRooms, activeRoom }: ResultsScreenProps) {
  return (
    <div className={`min-h-full ${isDesktop ? 'px-12 py-10' : 'px-6 py-6'}`}>
      <div className={isDesktop ? 'max-w-6xl mx-auto' : 'max-w-md mx-auto'}>

        {/* Back button — mobile only */}
        {!isDesktop && onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 -ml-1"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>
        )}

        {/* Header */}
        <div className={isDesktop ? 'mb-8' : 'mb-6'}>
          <h2 className={`${isDesktop ? 'text-3xl' : 'text-2xl'} mb-1 text-foreground`}>Available Rooms</h2>
          <p className={`${isDesktop ? 'text-base' : 'text-sm'} text-muted-foreground`}>
            {rooms.length} rooms available right now
          </p>
        </div>

        {/* Results Grid */}
        <div className={isDesktop ? 'grid grid-cols-2 gap-4' : 'space-y-3'}>
          {rooms.map((room, index) => {
            const studentOccupied = room.isStudentReportedOccupied ?? false;
            const occupancyCount  = room.studentOccupancyCount ?? 0;
            const isMyRoom        = activeRoom === room.id;

            return (
              <motion.button
                key={room.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                onClick={() => onRoomSelect(room)}
                className={`w-full border rounded-2xl p-4 hover:shadow-sm transition-all text-left ${
                  isMyRoom
                    ? 'bg-amber-50 border-amber-300 hover:border-amber-400'
                    : studentOccupied
                    ? 'bg-white border-amber-300 hover:border-amber-400'
                    : 'bg-white border-border hover:border-[#2563eb]/40'
                }`}
              >
                <div className="flex items-start justify-between gap-4">

                  {/* Room Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <MapPin className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm text-muted-foreground">{room.building}</span>
                    </div>

                    <div className="text-xl mb-1.5 text-foreground">Room {room.roomNumber}</div>

                    <div className="text-sm text-muted-foreground mb-3">
                      Floor {room.floor} · {room.type}
                    </div>

                    <div className="flex items-center gap-2 mb-2">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">
                        {room.nextClass ? `Next class at ${room.nextClass}` : 'No more classes today'}
                      </span>
                    </div>

                    {/* Student-reported occupancy badge */}
                    {isMyRoom && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <Users className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                        <span className="text-xs text-amber-700 font-medium">You're studying here</span>
                      </div>
                    )}
                    {!isMyRoom && studentOccupied && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <Users className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                        <span className="text-xs text-amber-700">
                          {occupancyCount === 1
                            ? '1 student currently here'
                            : `${occupancyCount} students currently here`}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Right side: availability badge + favorite */}
                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <motion.div
                      animate={{ scale: [1, 1.05, 1] }}
                      transition={{ duration: 2, repeat: Infinity, repeatDelay: 1 }}
                      className="bg-[#10b981] text-white px-4 py-2.5 rounded-xl text-center min-w-[80px]"
                    >
                      {room.availableFor === null ? (
                        <div className="text-lg leading-none py-1">All day</div>
                      ) : (
                        <>
                          <div className="text-2xl leading-none mb-0.5">
                            {formatAvailability(room.availableFor).split(' ')[0]}
                          </div>
                          {formatAvailability(room.availableFor).split(' ')[1] && (
                            <div className="text-xs opacity-90">
                              {formatAvailability(room.availableFor).split(' ')[1]}
                            </div>
                          )}
                        </>
                      )}
                    </motion.div>

                    {favorites.includes(room.id) && (
                      <Heart className="w-5 h-5 text-[#ef4444] fill-[#ef4444]" />
                    )}
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
