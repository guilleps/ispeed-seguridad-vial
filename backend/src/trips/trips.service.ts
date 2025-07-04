import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Trip } from './trip.entity';
import { Repository } from 'typeorm';
import { CreateTripDto } from './create-trip.dto';
import { TripMapper } from './trip.mappers';
import { Between } from 'typeorm';
import { AuthenticatedUser } from 'src/shared/interfaces/authenticated-user.interface';
import axios from 'axios';
import { UpdateTripDto } from './update-trip.dto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TripsService {
  constructor(
    private configService: ConfigService,
    @InjectRepository(Trip) private repo: Repository<Trip>
  ) { }

  async create(data: CreateTripDto) {
    const trip = TripMapper.toEntity(data);

    // Llamada al modelo de IA para predecir la conducta
    try {
      const conduct = await this.predictConduct(data); 
      trip.conduct = conduct; 
    } catch (err) {
      trip.conduct = 'DESCONOCIDA';
    }

    return await this.repo.save(trip);
  }

  async predictConduct(input: any): Promise<string> {
    const modelURL = this.configService.get<string>('ML_URL', 'http://localhost:5000')

    try {
      const response = await axios.post(`${modelURL}/predict`, input);
      return response.data.conduct; // "NORMAL" o "AGRESIVO"
    } catch (error) {
      console.error('Error al predecir la conducta:', error.message);
      return 'DESCONOCIDA';
    }
  }

  findByUserId(userId: string) {
    return this.repo.find({
      where: {
        user: {
          id: userId,
        },
      },
      relations: ['origin', 'destination', 'details'],
      order: { startDate: 'DESC' },
    });
  }

  findByCompanyId(companyId: string) {
    return this.repo.find({
      where: { companyId },
      relations: ['origin', 'destination', 'details', 'user'],
      order: { startDate: 'DESC' },
    });
  }

  async countCompanyTripsLastWeek(companyId: string): Promise<number> {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 (domingo) a 6 (sábado)

    // Ajustar a LUNES de la semana pasada
    const daysSinceMonday = (dayOfWeek + 6) % 7; // convierte domingo (0) en 6, lunes (1) en 0...
    const lastWeekMonday = new Date(today);
    lastWeekMonday.setDate(today.getDate() - daysSinceMonday - 7);
    lastWeekMonday.setHours(0, 0, 0, 0);

    // DOMINGO de la semana pasada
    const lastWeekSunday = new Date(lastWeekMonday);
    lastWeekSunday.setDate(lastWeekMonday.getDate() + 6);
    lastWeekSunday.setHours(23, 59, 59, 999);

    return this.repo.count({
      where: {
        companyId,
        startDate: Between(
          lastWeekMonday.toISOString(),
          lastWeekSunday.toISOString(),
        ),
      },
    });
  };

  async countCompanyTripsCurrentWeek(companyId: string): Promise<number> {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = domingo, 1 = lunes, ..., 6 = sábado

    const monday = new Date(today);
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    monday.setDate(today.getDate() - daysSinceMonday);
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    return this.repo.count({
      where: {
        companyId,
        startDate: Between(
          monday.toISOString(),
          sunday.toISOString()
        ),
      },
    });
  }

  async countByUserId(userId: string): Promise<number> {
    return this.repo.count({
      where: {
        user: { id: userId },
      },
    });
  }

  async getUniqueDestinationsByCompany(companyId: string) {
    const raw = await this.repo.query(`
        SELECT DISTINCT 
          CONCAT(o.name, ' - ', d.name) AS "route"
        FROM trips t
        JOIN cities o ON o.id = t."originId"
        JOIN cities d ON d.id = t."destinationId"
        WHERE t."companyId" = $1
      `, [companyId]);

    return raw.map((r) => r.route);
  }

  async getUniqueDestinationsByUser(userId: string) {
    const raw = await this.repo.query(`
        SELECT DISTINCT 
          CONCAT(o.name, ' - ', d.name) AS "route"
        FROM trips t
        JOIN cities o ON o.id = t."originId"
        JOIN cities d ON d.id = t."destinationId"
        WHERE t."userId" = $1
      `, [userId]);

    return raw.map((r) => r.route);
  }

  async searchTrips(user: AuthenticatedUser, filters: any): Promise<Trip[]> {
    const query = this.repo.createQueryBuilder('trip')
      .leftJoinAndSelect('trip.origin', 'origin')
      .leftJoinAndSelect('trip.destination', 'destination')
      .leftJoinAndSelect('trip.user', 'user')
      .leftJoinAndSelect('trip.details', 'details');

    if (user.role === 'company') {
      query.andWhere('trip.companyId = :companyId', { companyId: user.companyId });
    } else {
      query.andWhere('trip.user = :userId', { userId: user.userId });
    }

    if (filters.dateFrom) {
      query.andWhere('trip.startDate >= :dateFrom', { dateFrom: filters.dateFrom });
    }

    if (filters.dateTo) {
      query.andWhere('trip.startDate <= :dateTo', { dateTo: filters.dateTo });
    }

    if (filters.driver) {
      query.andWhere('user.id = :driverId', { driverId: filters.driver });
    }

    if (filters.destination) {
      query.andWhere(`CONCAT(origin.name, ' - ', destination.name) ILIKE :destination`, {
        destination: `%${filters.destination}%`
      });
    }

    if (filters.status) {
      query.andWhere('trip.status = :status', { status: filters.status });
    }

    const trips = await query.orderBy('trip.startDate', 'DESC').getMany();

    return trips.map((trip) => {
      const totalAlerts = trip.details?.length || 0;
      const respondedAlerts = trip.details?.filter(d => d.responded === true).length || 0;

      return {
        ...trip,
        totalAlerts,
        respondedAlerts,
      };
    });
  }

  // Todos los viajes de todos los conductores de la empresa
  async getTripsByCompany(companyId: string) {
    return this.repo.find({
      where: { companyId },
      relations: ['user', 'origin', 'destination', 'details'],
      order: { startDate: 'DESC' },
    });
  }

  // Solo los viajes del conductor actual
  async getTripsByDriver(userId: string) {
    return this.repo.find({
      where: { user: { id: userId } },
      relations: ['origin', 'destination', 'details'],
      order: { startDate: 'DESC' },
    });
  }

  findAll() {
    return this.repo.find();
  }

  findOne(id: string) {
    return this.repo.findOneBy({ id });
  }

  async update(id: string, updateTripDto: UpdateTripDto) {
    const trip = await this.repo.findOneBy({ id });
    if (!trip) throw new Error('Trip not found');

    // Si recibimos inputConduct, usamos el modelo
    if (updateTripDto.inputConduct) {
      const predicted = await this.predictConduct(updateTripDto.inputConduct);
      trip.conduct = predicted;
    }

    // Asignamos el resto de campos (como endDate, status)
    Object.assign(trip, updateTripDto);

    return this.repo.save(trip);
  }

  delete(id: number) {
    return this.repo.delete(id);
  }
}
